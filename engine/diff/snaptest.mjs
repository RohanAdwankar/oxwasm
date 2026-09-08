// Differential: snapshot and resume must land where an uninterrupted run does.
//
// snapshotEngine/restoreEngine capture a settled engine so a later process can
// resume instead of re-running startup. Nothing in the suite exercised them -
// they are reached only through the GUI tooling - and a format with no test is
// a format that drifts.
//
// The guest is stopped at the program's ENTRY, which is the moment the dynamic
// linker has finished and main has not begun: the most useful place to snapshot
// (a packed page could ship that state and skip ~150 ms of linking) and the
// most demanding, since every relocation, mapping and fd is already live.
//
// The size assertion is not decoration. Each mapping record carried its open
// FILE HANDLE, whose `bytes` JSON.stringify renders as an index-keyed object:
// eight mappings of libc and libcrypto came to 382 MB of JSON against 3.4 MB
// for the whole guest memory beside them, and the restored handle was a plain
// object whose `bytes` was not a typed array. Both were invisible because
// nothing looked at the size, so this looks.
import { LinuxEngine } from '../linux.mjs';
import { snapshotEngine, restoreEngine } from '../snapshot.mjs';
import { CPU } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = '/usr/bin/sha256sum';
if (!existsSync(BIN)) { console.log('snaptest SKIPPED: no ' + BIN); process.exit(0); }

const dir = mkdtempSync(join(tmpdir(), 'oxsnap-'));
let n = 0;
const assembleWat = (wat) => {
  const f = join(dir, 'u' + (n++));
  writeFileSync(f + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', f + '.wat', '-o', f + '.wasm']);
  return new Uint8Array(readFileSync(f + '.wasm'));
};

const IN = join(dir, 'in');
writeFileSync(IN, Buffer.from(Array.from({ length: 60000 }, (_, i) => (i * 31 + 7) & 0xFF)));

// a fresh file map per engine: a restored engine must not share buffers with
// the one that produced the snapshot, or the test would pass on aliasing
const mkFiles = () => {
  const o = {};
  for (const line of execFileSync('ldd', [BIN]).toString().split('\n')) {
    const m = line.match(/=>\s*(\/\S+)/) || line.match(/^\s*(\/\S+\.so[\d.]*)\s/);
    if (m) { o[m[1]] = new Uint8Array(readFileSync(m[1]));
             o['/lib/x86_64-linux-gnu/' + m[1].split('/').pop()] = o[m[1]]; }
  }
  o['/lib64/ld-linux-x86-64.so.2'] = new Uint8Array(readFileSync('/lib64/ld-linux-x86-64.so.2'));
  o['/data/in'] = new Uint8Array(readFileSync(IN));
  return o;
};
const elf = new Uint8Array(readFileSync(BIN));
const opts = () => ({ argv: ['sha256sum', '/data/in'], env: ['PATH=/usr/bin'],
                      files: mkFiles(), memMB: 512, assembleWat });
const drain = (eng, ms = 300000) => {
  const t0 = Date.now();
  while (eng.exitCode === null && Date.now() - t0 < ms) { eng.run(5e7); if (eng.blocked) eng.wake(); }
  return eng.stdout.join('');
};

let bad = 0;
const native = execFileSync(BIN, [IN]).toString().split(' ')[0];

// the uninterrupted run, for the resumed one to match
const straight = drain(new LinuxEngine(elf, opts())).split(' ')[0];
if (straight !== native) { console.log(`  FAIL straight run ${straight} != native ${native}`); bad++; }

// run to the program entry and snapshot there
class Stop extends Error {}
const eng = new LinuxEngine(elf, opts());
const ENTRY = eng.aux.entry;
const step = eng.cpu.step.bind(eng.cpu);
let stopped = false;
eng.cpu.step = function () { if (!stopped && this.rip === ENTRY) { stopped = true; throw new Stop(); } return step(); };
try { const t0 = Date.now();
      while (eng.exitCode === null && !stopped && Date.now() - t0 < 300000) { eng.run(5e7); if (eng.blocked) eng.wake(); } }
catch (e) { if (!(e instanceof Stop)) throw e; }
eng.cpu.step = step;
if (!stopped) { console.log('  FAIL never reached the program entry'); bad++; }

const snap = join(dir, 'snap');
await snapshotEngine(eng, null, snap);
const sizes = Object.fromEntries(['.json', '.blobs', '.mem'].map((x) => [x, statSync(snap + x).size]));

// The state JSON describes layout, threads and descriptors. It is kilobytes
// when nothing large is serialized into it by accident, and it was 382 MB.
const JSON_CAP = 1 << 20;
if (sizes['.json'] > JSON_CAP) {
  console.log(`  FAIL state JSON is ${sizes['.json']} bytes (cap ${JSON_CAP}): something large is being serialized that should not be`);
  bad++;
}

const eng2 = new LinuxEngine(elf, opts());
restoreEngine(eng2, null, snap, CPU);
const resumed = drain(eng2).split(' ')[0];
if (eng2.exitCode !== 0) { console.log(`  FAIL resumed run exited ${eng2.exitCode}`); bad++; }
if (resumed !== straight) { console.log(`  FAIL resumed ${resumed} != uninterrupted ${straight}`); bad++; }
if (resumed !== native) { console.log(`  FAIL resumed ${resumed} != native ${native}`); bad++; }

// the mappings must come back with a REAL handle: a plain JSON object whose
// bytes are index-keyed would satisfy every comparison above and still break
// the first msync through a shared mapping
for (const m of eng2.maps ?? []) {
  if (!m.h || !(m.h.bytes instanceof Uint8Array)) {
    console.log(`  FAIL mapping of ${m.path} restored without a usable file handle`);
    bad++; break;
  }
}

rmSync(dir, { recursive: true, force: true });
console.log(bad
  ? '\nsnapshot resume FAILED'
  : `\nsnapshot at the program entry resumes exactly (${eng.maps.length} mappings, ` +
    `state ${sizes['.json']}B + memory ${(sizes['.mem'] / 1e6).toFixed(1)}MB, resumed == uninterrupted == native)`);
if (bad) process.exit(1);
