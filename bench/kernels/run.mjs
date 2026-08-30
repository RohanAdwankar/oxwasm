// Run the instruction-class kernels on the engine and report the slowdown
// per class. The aggregate "5-10x off native" cannot say WHERE the tax is;
// these ratios can, and they decide whether a translator rewrite is worth
// doing and what it should target.
//
// Each kernel is timed at two iteration counts and the difference is taken,
// so process startup, ELF load and JIT compilation cancel out and what is
// left is steady-state throughput.
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
const runOnce = (kernel, n) => {
  const eng = new LinuxEngine(elf, { argv: ['kernels', kernel, String(n)], env: [],
                                     files: {}, memMB: 256, assembleWat });
  const t0 = process.hrtime.bigint();
  while (eng.exitCode === null) { eng.run(5e7); if (eng.blocked) eng.wake(); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, out: eng.stdout.join('').trim() };
};
const nativeOnce = (kernel, n) => {
  const t0 = process.hrtime.bigint();
  const out = execFileSync(BIN, [kernel, String(n)]).toString().trim();
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, out };
};

const N_HI = Number(process.env.N_HI || 20000000);
const N_LO = Number(process.env.N_LO || 2000000);
const kernels = (process.env.KERNELS || 'alu mem call branch subw muldiv').split(/\s+/);
const best = (f, reps) => { let b = Infinity, out = null;
  for (let i = 0; i < reps; i++) { const r = f(); if (r.ms < b) b = r.ms; out = r.out; }
  return { ms: b, out }; };

console.log('kernel      native(ms)  engine(ms)   ratio   (steady state, startup subtracted)');
const rows = [];
for (const k of kernels) {
  const nHi = best(() => nativeOnce(k, N_HI), 3), nLo = best(() => nativeOnce(k, N_LO), 3);
  const eHi = best(() => runOnce(k, N_HI), 2),   eLo = best(() => runOnce(k, N_LO), 2);
  // the same answer in both worlds, or the comparison is meaningless
  if (nHi.out !== eHi.out) { console.log(`${k}: MISMATCH native=${nHi.out} engine=${eHi.out}`); continue; }
  const nat = nHi.ms - nLo.ms, eng = eHi.ms - eLo.ms;
  const ratio = eng / nat;
  rows.push([k, nat, eng, ratio]);
  console.log(`${k.padEnd(10)} ${nat.toFixed(1).padStart(10)} ${eng.toFixed(1).padStart(11)} ${ratio.toFixed(1).padStart(7)}x`);
}
if (rows.length) {
  const rs = rows.map(r => r[3]).sort((a, b) => a - b);
  console.log(`\nspread: ${rs[0].toFixed(1)}x (${rows.find(r => r[3] === rs[0])[0]}) ` +
              `to ${rs[rs.length-1].toFixed(1)}x (${rows.find(r => r[3] === rs[rs.length-1])[0]})`);
}
