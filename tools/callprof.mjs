// What does real code actually call?
//
// The kernel benchmarks say the per-call charge is fixed: a 1-op callee runs
// at 7.78x native, a 64-op callee at 1.38x. That makes the size of the
// callee, not the call, the thing that decides whether the charge matters —
// and nothing so far has measured the callee sizes of real programs. If real
// hot code calls big functions the charge is already amortised and the whole
// call-boundary line of inquiry is a synthetic artifact; if it calls small
// ones, inlining them is worth building.
//
// Method: run an unmodified binary in the INTERPRETER (no assembleWat), where
// cpu.onCall fires for every executed call, and count targets. The dynamic
// call mix is a property of the program and its input, not of the tier that
// runs it, so interpreting measures the same distribution the JIT would see.
// Then size each target by decoding it.
//
//   node tools/callprof.mjs /bin/gzip -c /some/file > /dev/null
import { LinuxEngine } from '../engine/linux.mjs';
import { analyze } from '../engine/aot_wat.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = {}, mtimes = {};
// Real mtimes, not 0. An epoch-zero mtime is not neutral: gzip refuses to
// store it and warns "file timestamp out of range", exiting 2 — which native
// gzip does too on a `touch -d @0` file. The first run of this tool spent a
// detour on that warning as if it were an engine bug. It was the file set.
const add = (g, h) => {
  try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); }
  catch {}
};
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');

const bin = process.argv[2], args = process.argv.slice(3);
if (!bin) { console.log('usage: callprof.mjs <binary> [args...]'); process.exit(1); }
add(bin, bin);
for (const p of (process.env.EXTRA || '').split(':').filter(Boolean)) add(p, p);
for (const p of (process.env.INFILE || '').split(':').filter(Boolean)) add(p, p);
// TREE=/usr/lib/python3.11 — an interpreter is not one file. Without its
// stdlib CPython never reaches main(), and the call mix measured would be
// the mix of its own startup failure.
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f);
    let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);

const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C'],
    files, mtimes, memMB: Number(process.env.MEMMB || 512) });

// Every executed call, direct or via a PLT landing. The engine installs these
// only when it can tier up; here nothing tiers, so they are ours alone.
const hits = new Map();
const bump = (t) => hits.set(t, (hits.get(t) || 0) + 1);
eng.cpu.onCall = bump;
eng.cpu.onJmp = (t) => { if (eng.inExec(t)) bump(t); };

const BUDGET = Number(process.env.STEPS || 4e9);
let steps = 0;
while (eng.exitCode === null && steps < BUDGET) { steps += 5e6; eng.run(5e6); if (eng.blocked) eng.wake(); }

// Size a callee the way an inliner would have to: the same whole-function
// analysis the AOT unit builder runs, so the instruction count is the real
// one across every block, not a straight-line guess. A callee an inliner can
// splice is one that analyzes at all, contains no call of its own (a
// non-leaf's frame stays whichever way), and is small enough that duplicating
// it at each site is cheaper than the frame it removes.
const WINDOW = Number(process.env.WINDOW || 64);
const shapeOf = (rip) => {
  let an;
  try { an = analyze(eng.mem, rip, { maxInsns: 2000 }); }
  catch { return { n: 0, kind: 'unanalyzable' }; }
  let n = 0, syscall = false;
  for (const b of an.blocks) for (const i of b.insns) {
    n++;
    if (i.mnem === 'udec') return { n, kind: 'unanalyzable' };
    if (i.mnem === 'syscall' || i.mnem === 'callind') syscall = true;
  }
  if (syscall || an.calls.size) return { n, kind: 'nonleaf' };
  return { n, kind: n <= WINDOW ? 'leaf' : 'large' };
};

const rows = [...hits].map(([t, c]) => ({ t, c, ...shapeOf(t) }));
rows.sort((a, b) => b.c - a.c);
const total = rows.reduce((s, r) => s + r.c, 0);

const buckets = [[1, 4], [5, 8], [9, 16], [17, 32], [33, 64]];
console.log(`binary       ${bin} ${args.join(' ')}`);
console.log(`exit         ${eng.exitCode}${steps >= BUDGET ? '  (STEP BUDGET HIT - partial)' : ''}`);
// A nonzero guest exit is a breadth signal, not noise: print what the guest
// said about it rather than leaving the number unexplained.
if (eng.exitCode) for (const l of (eng.stderr || []).join('').trim().split('\n').slice(0, 6))
  console.log(`stderr       ${l}`);
console.log(`call sites   ${rows.length} distinct targets, ${total} dynamic calls`);
// The decisive statistic, and not the one this tool was written to collect.
// The per-call charge measured on the kernels is fixed at roughly 22 native
// instruction-times (fitting ratio = (F + k*W)/(c + W) through the 1/8/64-op
// points gives F ~ 22, k ~ 1.1). What that costs a real program therefore
// depends entirely on how far apart its calls are: at 20 instructions per
// call the charge is half the runtime, at 1000 it is 2%.
const insns = eng.stats.interpreted;
const ipc = total ? insns / total : Infinity;
const share = 22 / (1.1 * ipc + 22) * 100;
console.log(`density      ${insns} instructions, ${ipc.toFixed(0)} per call`);
console.log(`             => fixed per-call charge is ~${share.toFixed(1)}% of engine runtime`);
console.log('');
console.log('splice-able leaf callees, by size (share of all dynamic calls):');
let leafTot = 0;
for (const [lo, hi] of buckets) {
  const c = rows.filter(r => r.kind === 'leaf' && r.n >= lo && r.n <= hi).reduce((s, r) => s + r.c, 0);
  leafTot += c;
  console.log(`  ${String(lo).padStart(3)}-${String(hi).padEnd(3)} insns  ${(c / total * 100).toFixed(1).padStart(6)}%  ${c}`);
}
for (const k of ['nonleaf', 'large', 'unanalyzable']) {
  const c = rows.filter(r => r.kind === k).reduce((s, r) => s + r.c, 0);
  console.log(`  ${k.padEnd(12)} ${(c / total * 100).toFixed(1).padStart(6)}%  ${c}`);
}
console.log('');
console.log(`SPLICE-ABLE: ${(leafTot / total * 100).toFixed(1)}% of dynamic calls analyze as leaf functions of <=${WINDOW} insns`);
console.log('');
console.log('top targets:');
for (const r of rows.slice(0, 15))
  console.log(`  ${r.t.toString(16).padStart(12)}  ${String(r.c).padStart(9)}  ${(r.c / total * 100).toFixed(1).padStart(5)}%  ${r.kind}/${r.n}`);
