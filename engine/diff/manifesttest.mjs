// Differential: a run that REPLAYS precompiled units must answer exactly like
// one that translates them itself.
//
// m3pack --train runs the program at pack time and embeds the wasm units it
// translated; the page registers those with no translation at all, which is
// where its startup goes. That makes the manifest a correctness surface: a
// unit compiled against one memory image and replayed against another would
// run the wrong code and nothing about the page would say so.
//
// The property is checked three ways, because two of them can agree while
// being wrong together:
//   1. the replayed run matches a plain translating run, byte for byte;
//   2. both match the binary run NATIVELY on this host;
//   3. the replay actually USED the manifest - a run that silently fell back
//      to translating everything would pass 1 and 2 and test nothing.
//
// It also pins the determinism the whole idea rests on: two training runs of
// the same binary must produce the same entries with byte-identical wasm. If
// that ever stops holding, a packed page's units stop being safe to ship and
// this test is the thing that says so.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = '/usr/bin/sha256sum';
if (!existsSync(BIN)) { console.log('manifesttest SKIPPED: no ' + BIN); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'oxman-'));
let n = 0, assembled = 0;
const assembleWat = (wat) => {
  const f = join(dir, 'u' + (n++)); assembled++;
  writeFileSync(f + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', f + '.wat', '-o', f + '.wasm']);
  return new Uint8Array(readFileSync(f + '.wasm'));
};

// a few kB is enough: the point is the unit set, not the throughput
const IN = join(dir, 'in');
writeFileSync(IN, Buffer.from(Array.from({ length: 40000 }, (_, i) => (i * 31 + 7) & 0xFF)));

const libs = {};
for (const line of execFileSync('ldd', [BIN]).toString().split('\n')) {
  const m = line.match(/=>\s*(\/\S+)/) || line.match(/^\s*(\/\S+\.so[\d.]*)\s/);
  if (m) libs[m[1]] = new Uint8Array(readFileSync(m[1]));
}
libs['/lib64/ld-linux-x86-64.so.2'] = new Uint8Array(readFileSync('/lib64/ld-linux-x86-64.so.2'));
const files = { ...libs, '/data/in': new Uint8Array(readFileSync(IN)) };
const elf = new Uint8Array(readFileSync(BIN));

const run = (opts) => {
  const eng = new LinuxEngine(elf, { argv: ['sha256sum', '/data/in'], env: ['PATH=/usr/bin'],
                                     files, memMB: 512, assembleWat, ...opts.engine });
  if (opts.capture) eng.onUnitBytes = (k, b) => { if (!opts.capture.has(k)) opts.capture.set(k, Buffer.from(b)); };
  if (opts.units) { let hits = 0; eng.unitBytes = (k) => { const b = opts.units.get(k); if (b) hits++; return b; };
                    eng.__hits = () => hits; }
  const t0 = Date.now(); assembled = 0;
  while (eng.exitCode === null && Date.now() - t0 < 300000) { eng.run(5e7); if (eng.blocked) eng.wake(); }
  let len = 0; for (const c of eng.stdoutBytes || []) len += c.length;
  const raw = Buffer.alloc(len); let o = 0;
  for (const c of eng.stdoutBytes || []) { raw.set(c, o); o += c.length; }
  // assembled, not stats.tiers.aot: registering a manifest unit bumps that
  // counter too, so it would report a replay as having translated everything
  return { exit: eng.exitCode, out: raw, hits: eng.__hits ? eng.__hits() : 0, assembled };
};

let bad = 0;
const native = execFileSync(BIN, [IN]).toString().split(' ')[0];

// 1. two training runs, for the determinism the shipping idea rests on
const capA = new Map(), capB = new Map();
const a = run({ capture: capA }), b = run({ capture: capB });
const ka = [...capA.keys()].map(String).sort(), kb = [...capB.keys()].map(String).sort();
const sameSet = ka.length === kb.length && ka.every((k, i) => k === kb[i]);
let byteDiff = 0;
if (sameSet) for (const k of capA.keys()) if (Buffer.compare(capA.get(k), capB.get(k)) !== 0) byteDiff++;
if (!sameSet || byteDiff) {
  console.log(`  FAIL two training runs disagree: ${ka.length} vs ${kb.length} entries, ${byteDiff} differing in bytes`);
  bad++;
} else console.log(`  two training runs: ${ka.length} units, identical entries and bytes`);

// 2. replay the captured units, and 3. check the replay really used them
const r = run({ units: capA });
if (r.hits === 0) { console.log('  FAIL the replay registered no manifest unit - it translated everything and tested nothing'); bad++; }
else console.log(`  replay registered ${r.hits} units from the manifest and assembled ${r.assembled} itself (a plain run assembles ${a.assembled})`);

if (a.exit !== 0 || r.exit !== 0) { console.log(`  FAIL exit codes: plain ${a.exit}, replay ${r.exit}`); bad++; }
if (Buffer.compare(a.out, r.out) !== 0) {
  console.log(`  FAIL replay output differs from a translating run (${a.out.length}B vs ${r.out.length}B)`);
  bad++;
}
for (const [label, got] of [['plain', a.out], ['replay', r.out]]) {
  const hash = got.toString().split(' ')[0];
  if (hash !== native) { console.log(`  FAIL ${label} hash ${hash} != native ${native}`); bad++; }
}

rmSync(dir, { recursive: true, force: true });
console.log(bad ? '\nprecompiled-unit replay FAILED'
                : `\nprecompiled-unit replay is exact: same units both trainings, replay == translation == native (${native.slice(0, 16)}…)`);
if (bad) process.exit(1);
