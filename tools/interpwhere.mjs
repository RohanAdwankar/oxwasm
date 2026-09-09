// Where do the interpreted instructions come from?
//
// The sweep prints an interpreted-instruction count per case and nothing about
// its composition, and the two numbers that matter are not in it. 254 million
// instructions are interpreted across the 170 cases; 102 million of them are
// one case (java-hello) and 71 million another (java-jit), so two thirds of
// all remaining interpretation is the JVM. Nothing said WHY.
//
// The hot-refusal list is the only answer this project has had, and it now
// reports almost nothing: the largest refused-and-then-executed function in
// the whole sweep runs 4,727 times. So the interpretation is not refusals. It
// is either code that never got hot enough to translate, or code in memory
// the engine does not treat as a translatable function at all - a JIT's own
// output, which is what a JVM spends its time in.
//
// This attributes each interpreted instruction to the mapping it came from, by
// sampling the interpreter's rip. Anonymous memory means generated code; a
// file path means the program's own text or a library's. The tail of the
// report names the individual addresses, so a bucket can be turned into a
// function to look at.
//
//   node tools/interpwhere.mjs /bin/gzip -c file > /dev/null
//   TREE=/usr/lib/jvm/... EXECANON=1 node tools/interpwhere.mjs java -version
import { ensureHeapFlags } from './v8flags.mjs';
ensureHeapFlags();
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync,
         writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const files = {}, mtimes = {};
const add = (g, h) => { try { files[g] = new Uint8Array(readFileSync(h));
                              mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); } catch {} };
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} } }
add('/etc/ld.so.cache', '/etc/ld.so.cache');
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);

const bin = process.argv[2], args = process.argv.slice(3);
if (!bin) { console.log('usage: interpwhere.mjs <binary> [args...]'); process.exit(2); }
add(bin, bin);
for (const p of args) if (existsSync(p)) add(p, p);

const CACHE = new URL('../bench/kernels/watcache/', import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true }); let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/iw_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: (process.env.GUESTENV || 'PATH=/usr/bin:/bin,LANG=C,HOME=/root').split(','),
    files, mtimes, memMB: Number(process.env.MEMMB || 2048), assembleWat });
if (process.env.EXECANON === '1') eng.execAnon = true;

// The engine already samples every 64th interpreted instruction by rip into
// globalThis.__ihist, at BOTH of its interpretation loops - the run loop and
// the callout loop. Wrapping cpu.step from out here instead looked equivalent
// and was not: a guest that spawns threads gets a new CPU per thread and the
// wrapper stays on the first one, so java-hello reported 1,275 samples of
// 102,007,672 instructions and I nearly read the shape of 0.08% of the run as
// the shape of the run.
const EVERY = 64;
const byMap = new Map();
globalThis.__ihist = new Map();

// The ELF images the engine loaded itself are not in eng.maps - only what the
// guest mmapped afterwards is. Without them every instruction in the main
// binary and in ld.so is attributed to "anonymous", which is the one bucket
// this tool exists to distinguish, so the first version of it reported gzip
// as 88% generated code.
// A STATIC binary has no interpreter and aux.base is 0, which made every
// range compare >= it: busybox came out as "100% dynamic linker" when it does
// not have one.
const LDBASE = eng.aux?.base > 0n ? eng.aux.base : null;
const IMAGES = (eng.execRangesStatic ?? []).map(([lo, hi]) =>
  [lo, hi, LDBASE !== null && lo >= LDBASE ? 'ld.so (dynamic linker)' : bin]);
const where = (rip) => {
  for (const m of eng.maps ?? []) if (rip >= m.at && rip < m.at + BigInt(m.len)) return m.path;
  for (const [lo, hi, name] of IMAGES) if (rip >= lo && rip < hi) return name;
  return 'anonymous (generated code)';
};

// MAXMS caps the run and reports what it has. A configuration that does not
// finish reports nothing at all otherwise, which is the least useful outcome
// available: "it did not finish" is a fact about the wall clock and says
// nothing about where the time went.
const MAXMS = Number(process.env.MAXMS || 0), t0 = performance.now();
let err = null;
const QUANTUM = MAXMS ? 2e5 : 5e6;   // a smaller slice when capped, so the cap is checked often enough to hold
try { let g = 0; while (eng.exitCode === null) { eng.run(QUANTUM); if (eng.blocked) eng.wake();
        if (MAXMS && performance.now() - t0 > MAXMS) { err = 'TRUNCATED at ' + MAXMS + 'ms'; break; }
        if (++g > (MAXMS ? 4e6 : 40000)) { err = 'no exit'; break; } } }
catch (e) { err = e.message; }

// The rips come back as whatever the engine held; normalise and attribute
// once, at the end, so the run itself pays nothing for the mapping lookups.
const byRip = new Map();
let sampled = 0;
for (const [k, v] of globalThis.__ihist) {
  const rip = BigInt.asUintN(64, BigInt(k));
  byRip.set(rip, (byRip.get(rip) || 0) + v);
  byMap.set(where(rip), (byMap.get(where(rip)) || 0) + v);
  sampled += v;
}

const total = eng.stats.interpreted || 0;
console.log(`\n${bin} ${args.join(' ')}${err ? '  [' + err + ']' : ''}  exit=${eng.exitCode}`);
console.log(`interpreted ${total} instructions, ${sampled} sampled (1 in ${EVERY}), aot dispatches ${eng.stats.aotRuns ?? 0}` +
            ` in ${Math.round(performance.now() - t0)}ms`);
console.log(`units compiled ${eng._unitN ?? 0}, functions registered ${eng.aotFns?.size ?? 0}, refused ${eng.aotFailed?.size ?? 0}, deopts ${eng.stats.deopts ?? 0}`);
if (eng.stats.codeWrites) console.log(`code writes seen ${eng.stats.codeWrites}, volatile pages ${eng.stats.volatilePages ?? 0}`);

// Counts are the SHARE of the real total, not sample*64: the two differ by a
// few percent and printing a number larger than the total the same report
// prints invites the reader to distrust both.
console.log('\nwhere the interpreted instructions are:');
for (const [k, v] of [...byMap].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`  ${(100 * v / Math.max(1, sampled)).toFixed(1).padStart(5)}%  ${Math.round(total * v / Math.max(1, sampled)).toString().padStart(11)}  ${k}`);

// The addresses themselves, so a bucket can be turned into a function. A rip
// that the engine offered to the translator and refused prints the reason;
// one it never offered is code that never got hot, which is a different
// problem with a different fix.
console.log('\nhottest interpreted addresses:');
const why = eng._aotWhy ?? new Map();
for (const [rip, v] of [...byRip].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  const w = why.get(rip);
  console.log(`  ${Math.round(total * v / Math.max(1, sampled)).toString().padStart(10)}  0x${rip.toString(16).padStart(12)}  ${where(rip).split('/').pop()}` +
              (w ? `  REFUSED: ${w}` : ''));
}
const hot = eng.hotFailures ? eng.hotFailures(1000) : [];
if (hot.length) {
  console.log('\nrefused and then executed anyway (>=1000 calls):');
  for (const h of hot.slice(0, 8)) console.log(`  ${String(h.calls).padStart(8)}  0x${h.addr.toString(16)}  ${h.why}`);
}
