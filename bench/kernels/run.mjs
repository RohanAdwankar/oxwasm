// Per-class slowdown vs native, with a measurement good enough to trust.
//
// The first version of this harness could not resolve a 10% effect: a
// codegen change was nearly accepted on a difference smaller than the
// run-to-run variance of a control kernel it could not affect. Three things
// were wrong, and this version fixes all three.
//
//  1. It reported best-of-N as a bare number, hiding how much of itself was
//     noise. Now it reports the spread and, at the end, runs the SAME
//     configuration twice and prints how far the two agree — if that
//     self-check disagrees by more than the effect you are chasing, the
//     harness cannot see your change and nothing else it says matters.
//
//  2. It subtracted two separately-measured timings (hi minus lo) to cancel
//     startup, which adds their errors. Startup is now measured once and,
//     with a large enough iteration count, is a small correction rather than
//     half the arithmetic.
//
//  3. Two reps. Now REPS (default 7) with a median, which does not chase
//     the one lucky run the way best-of does.
import { LinuxEngine } from '../../engine/linux.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const BIN = new URL('./kernels', import.meta.url).pathname;
const CACHE = new URL('./watcache/', import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true });
let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/kn_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

const elf = new Uint8Array(readFileSync(BIN));
const engineOnce = (kernel, n) => {
  const eng = new LinuxEngine(elf, { argv: ['kernels', kernel, String(n)], env: [],
                                     files: {}, memMB: 256, assembleWat });
  const t0 = process.hrtime.bigint();
  while (eng.exitCode === null) { eng.run(5e7); if (eng.blocked) eng.wake(); }
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out: eng.stdout.join('').trim() };
};
const nativeOnce = (kernel, n) => {
  const t0 = process.hrtime.bigint();
  const out = execFileSync(BIN, [kernel, String(n)]).toString().trim();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out };
};

const REPS = Number(process.env.REPS || 7);
const N = Number(process.env.N || 60000000);      // big enough that startup is a correction
const kernels = (process.env.KERNELS || 'alu mem call branch subw muldiv').split(/\s+/);

const stat = (f, reps) => {
  const xs = []; let out = null;
  for (let i = 0; i < reps; i++) { const r = f(); xs.push(r.ms); out = r.out; }
  xs.sort((a, b) => a - b);
  const med = xs[xs.length >> 1];
  return { med, lo: xs[0], hi: xs[xs.length - 1], spread: (xs[xs.length - 1] - xs[0]) / med * 100, out };
};

// Startup (ELF load + JIT) is a fixed cost per run, so the iteration count
// has to be large enough that it is a correction rather than the
// measurement. Kernels differ by 10x in cost per iteration, so one N cannot
// serve them all: at N=40M, `alu` was 61% startup with a +/-168% spread —
// it was mostly timing the compiler. Calibrate N per kernel until the
// steady-state work is at least MIN_RATIO times the startup.
const MIN_RATIO = Number(process.env.MIN_WORK || 8);
const measure = (k, fixedN) => {
  const eng0 = stat(() => engineOnce(k, 1), 3).med;          // startup alone
  let n = fixedN || N;
  if (!fixedN) {
    for (let i = 0; i < 6; i++) {
      const probe = engineOnce(k, n).ms - eng0;
      if (probe >= eng0 * MIN_RATIO) break;
      n = Math.round(n * Math.max(2, (eng0 * MIN_RATIO) / Math.max(probe, 1)));
    }
  }
  engineOnce(k, n);                                          // warm the wat cache and V8
  const nat = stat(() => nativeOnce(k, n), REPS);
  const eng = stat(() => engineOnce(k, n), REPS);
  if (nat.out !== eng.out) return { k, bad: `MISMATCH native=${nat.out} engine=${eng.out}` };
  const work = eng.med - eng0;
  return { k, n, nat: nat.med, eng: eng.med, start: eng0,
           startPct: eng0 / eng.med * 100, ratio: work / nat.med,
           natSpread: nat.spread, engSpread: eng.spread };
};

console.log(`N=${N} reps=${REPS}`);
console.log('kernel      native(ms)  engine(ms)  startup%   ratio   spread        N');
const results = [];
for (const k of kernels) {
  const r = measure(k);
  if (r.bad) { console.log(`${k.padEnd(10)} ${r.bad}`); continue; }
  results.push(r);
  console.log(`${r.k.padEnd(10)} ${r.nat.toFixed(1).padStart(10)} ${r.eng.toFixed(1).padStart(11)} ` +
              `${r.startPct.toFixed(1).padStart(8)}% ${r.ratio.toFixed(2).padStart(7)}x ` +
              `  +/-${String(r.engSpread.toFixed(0)).padStart(3)}%  ${(r.n/1e6).toFixed(0)}M`);
}

// Self-check: measure one kernel a second time, same configuration. Whatever
// these two disagree by is the smallest effect this harness can see.
// SELFCHECK=0 skips it: when A/B'ing two configurations the second
// measurement of each is the comparison, and the self-check doubles an
// already long run.
const probe = process.env.SELFCHECK === '0' ? null : (results[0]?.k ?? kernels[0]);
if (probe) {
  const nProbe = results[0]?.n;
  const a = measure(probe, nProbe), b = measure(probe, nProbe);
  if (!a.bad && !b.bad) {
    const disagree = Math.abs(a.ratio - b.ratio) / a.ratio * 100;
    console.log(`\nself-check: ${probe} measured twice -> ${a.ratio.toFixed(2)}x and ${b.ratio.toFixed(2)}x`);
    console.log(`RESOLUTION: this harness cannot see an effect smaller than ~${disagree.toFixed(0)}%.`);
  }
}
