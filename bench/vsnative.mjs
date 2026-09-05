// Steady-state cost of a real binary under the engine, against native.
//
// The same two-size subtraction as realab.mjs (startup, ELF load and
// tiering are the same at both sizes; what differs is the work), applied
// to both sides: the engine through realab-run.mjs, native through
// execFileSync. Prints each side's steady state and the ratio.
//
//   node bench/vsnative.mjs --big /tmp/big.m4 --small /tmp/small.m4 [--reps 5] -- /usr/bin/m4 {IN}
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const dashdash = argv.indexOf('--');
if (dashdash < 0) { console.log('usage: vsnative.mjs --big F --small F [--reps N] [--env "K=V ..."] -- <binary> <args with {IN}>'); process.exit(1); }
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 && i < dashdash ? argv[i + 1] : dflt; };
const BIG = opt('big'), SMALL = opt('small'), REPS = Number(opt('reps', 5));
const ENV = Object.fromEntries((opt('env', '')).split(/\s+/).filter(Boolean).map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const cmd = argv.slice(dashdash + 1);
if (!BIG || !SMALL) { console.log('need --big and --small'); process.exit(1); }

const RUNNER = new URL('./realab-run.mjs', import.meta.url).pathname;
const engineOnce = (input) => {
  const out = execFileSync(process.execPath, [RUNNER, ...cmd.map(a => a.replace('{IN}', input))],
    { env: { ...process.env, ...ENV, INFILE: input }, encoding: 'utf8', maxBuffer: 1 << 26 });
  const m = /^RESULT (\d+(?:\.\d+)?) (\S+) (\S+)$/m.exec(out);
  if (!m) { console.log(out); throw new Error('no RESULT line'); }
  return Number(m[1]);
};
const nativeOnce = (input) => {
  const t0 = process.hrtime.bigint();
  try { execFileSync(cmd[0], cmd.slice(1).map(a => a.replace('{IN}', input)), { stdio: ['ignore', 'ignore', 'ignore'] }); } catch {}
  return Number(process.hrtime.bigint() - t0) / 1e6;
};
const med = (xs) => { const y = [...xs].sort((a, b) => a - b); return y[y.length >> 1]; };
const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / med(xs) * 100;

engineOnce(BIG); engineOnce(SMALL); nativeOnce(BIG); nativeOnce(SMALL);     // warm caches
const eb = [], es = [], nb = [], ns = [];
for (let i = 0; i < REPS; i++) { eb.push(engineOnce(BIG)); es.push(engineOnce(SMALL)); nb.push(nativeOnce(BIG)); ns.push(nativeOnce(SMALL)); }
const E = med(eb) - med(es), N = med(nb) - med(ns);
console.log(`engine  big ${med(eb).toFixed(0).padStart(7)}ms  small ${med(es).toFixed(0).padStart(7)}ms  steady ${E.toFixed(0).padStart(7)}ms  +/-${spread(eb).toFixed(0)}%`);
console.log(`native  big ${med(nb).toFixed(0).padStart(7)}ms  small ${med(ns).toFixed(0).padStart(7)}ms  steady ${N.toFixed(0).padStart(7)}ms  +/-${spread(nb).toFixed(0)}%`);
console.log(`startup is ${(med(es) / med(eb) * 100).toFixed(0)}% of the engine's big run` + (med(es) / med(eb) > 0.5 ? '  <- too much: use a bigger --big' : ''));
console.log(`engine/native steady state: ${(E / N).toFixed(2)}x`);
