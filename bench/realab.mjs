// Steady-state A/B of a real binary under two engine configurations.
//
// Wall-clock on a real binary is not a measurement of the translator. gzip on
// 200KB and on 2MB both take about a second in this engine, because almost all
// of it is ELF load, tiering and wat2wasm - the compression loop is a slice.
// An A/B run that way showed inlining "2.5x faster" and was entirely cold
// assembler cache. So: run each configuration at TWO input sizes, take medians,
// and subtract. What is left is the steady state, which is the only part a
// codegen change can move.
//
//   node bench/realab.mjs --big /tmp/big.bin --small /tmp/small.bin \
//        --a '' --b 'OXWASM_INLINE=1' -- /bin/gzip -1 -c {IN}
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
if (dashdash < 0) { console.log('usage: realab.mjs [opts] -- <binary> <args with {IN}>'); process.exit(1); }
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && i < dashdash ? argv[i + 1] : dflt; };
const BIG = opt('big'), SMALL = opt('small');
const A = opt('a', ''), B = opt('b', '');
const REPS = Number(opt('reps', 5));
const cmd = argv.slice(dashdash + 1);
if (!BIG || !SMALL) { console.log('need --big and --small'); process.exit(1); }

// Each measurement is its own node process: the wat cache, the engine's
// compiled-unit maps and V8's own tiering all persist within a process, and
// sharing them between the two configurations would let one warm the other.
const RUNNER = new URL('./realab-run.mjs', import.meta.url).pathname;
const once = (env, input) => {
  const out = execFileSync(process.execPath, [RUNNER, ...cmd.map(a => a.replace('{IN}', input))],
    { env: { ...process.env, ...env, INFILE: input }, encoding: 'utf8' });
  const m = /^RESULT (\d+(?:\.\d+)?) (\S+) (\S+)$/m.exec(out);
  if (!m) { console.log(out); throw new Error('no RESULT line'); }
  return { ms: Number(m[1]), exit: m[2], hash: m[3] };
};
const med = (xs) => { const y = [...xs].sort((a, b) => a - b); return y[y.length >> 1]; };
const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / med(xs) * 100;

const parseEnv = (s) => Object.fromEntries(s.split(/\s+/).filter(Boolean).map(kv => {
  const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));

// Interleave the arms. Running all of A and then all of B lets any drift in
// machine speed land entirely on one of them: a run of this A/B reported
// +/-8% on the first arm and +/-5% on the second, which is not a difference
// between configurations, it is the machine changing underneath. Alternating
// rep by rep makes drift common-mode, the same fix the stack-guard A/B needed
// when it was done by hand.
const parsed = { A: parseEnv(A), B: parseEnv(B) };
const bigs = { A: [], B: [] }, smalls = { A: [], B: [] }, meta = {};
for (const k of ['A', 'B']) { once(parsed[k], BIG); once(parsed[k], SMALL); }   // warm both caches first
for (let i = 0; i < REPS; i++) {
  for (const k of ['A', 'B']) {
    const rb = once(parsed[k], BIG); bigs[k].push(rb.ms); meta[k] = rb;
    smalls[k].push(once(parsed[k], SMALL).ms);
  }
}
const report = (label, k) => {
  const b = med(bigs[k]), s = med(smalls[k]);
  console.log(`${label.padEnd(28)} big ${b.toFixed(0).padStart(6)}ms  small ${s.toFixed(0).padStart(6)}ms` +
              `  steady ${(b - s).toFixed(0).padStart(6)}ms  +/-${spread(bigs[k]).toFixed(0)}%` +
              `  exit=${meta[k].exit} out=${meta[k].hash}`);
  return { steady: b - s, big: b, small: s, spread: spread(bigs[k]), hash: meta[k].hash, exit: meta[k].exit };
};

const ra = report('A: ' + (A || '(baseline)'), 'A');
const rb = report('B: ' + (B || '(baseline)'), 'B');
console.log('');
if (ra.hash !== rb.hash || ra.exit !== rb.exit)
  console.log(`DIVERGED: A ${ra.exit}/${ra.hash} vs B ${rb.exit}/${rb.hash} - the two are not the same program`);
else console.log(`identical output (${ra.hash}), exit ${ra.exit}`);
const startupShare = ra.small / ra.big * 100;
console.log(`startup is ${startupShare.toFixed(0)}% of A's big run` +
            (startupShare > 50 ? '  <- too much: use a bigger --big or this cannot resolve anything' : ''));
const r = rb.steady / ra.steady;
const noise = Math.max(ra.spread, rb.spread);
console.log(`B/A steady state: ${r.toFixed(3)}x  (harness noise +/-${noise.toFixed(0)}%)`);
if (Math.abs(1 - r) * 100 < noise)
  console.log('=> INSIDE THE NOISE. This run does not distinguish the two.');
