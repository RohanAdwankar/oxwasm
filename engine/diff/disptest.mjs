// Differential test for the br_table dispatch fallback (irreducible / improper
// control flow the scope-nesting Stackifier can't handle). Compiles an
// irreducible-CFG function to wasm in dispatch mode and checks it bit-exact
// against the hardware-verified interpreter across many inputs.
globalThis.__enableDispatch = true;   // exercise the (experimental, off-by-default) br_table dispatch fallback
import { LinuxEngine } from '../linux.mjs';
import { compileUnitWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'disp-'));
// irreducible CFG: two entries into a strongly-connected region chosen by
// parity, with a cross edge between them (goto even / goto odd).
const C = `#include <stdint.h>
__attribute__((noinline))
uint64_t irr(uint64_t n, uint64_t seed){
  uint64_t a = seed, i = 0;
  if (n & 1) goto odd;
even:
  a = a*6364136223846793005ULL + 1; a ^= i; i++; if (i >= n) return a;
  a += (a >> 7);
odd:
  a = a*2862933555777941757ULL + 3; a ^= (i<<1); i++; if (i >= n) return a;
  a -= (a << 11);
  goto even;
}
int _start(){ return 0; }`;
writeFileSync(join(dir, 'irr.c'), C);
execFileSync('gcc', ['-O2', '-static', '-nostdlib', '-o', join(dir, 'irr'), join(dir, 'irr.c')]);
const elf = new Uint8Array(readFileSync(join(dir, 'irr')));
const entry = BigInt('0x' + execFileSync('nm', [join(dir, 'irr')]).toString().split('\n').find(l => / T irr$/.test(l)).trim().split(/\s+/)[0]);

const mk = () => new LinuxEngine(elf, { argv: ['irr'], files: {}, memMB: 256 });
const eng0 = mk();
const unit = compileUnitWat(eng0.mem, entry, { guestBase: eng0.base, ramBase: eng0.RAMOFF });
if (!unit.wat.includes('$L_disp')) { console.log('SETUP FAIL: irr did not compile in dispatch mode'); process.exit(1); }
writeFileSync(join(dir, 'irr.wat'), unit.wat);
execFileSync('wat2wasm', [join(dir, 'irr.wat'), '-o', join(dir, 'irr.wasm')]);
const mod = new WebAssembly.Module(readFileSync(join(dir, 'irr.wasm')));
const entryName = 'f_' + entry.toString(16);
const SENT = 0xdeadbee0n;

const seeds = [1n, 2n, 3n, 7n, 0xffffffffn, 0x123456789abcdefn, 0x8000000000000000n,
  0xdeadbeefcafebaben, (1n<<64n)-1n, 0x9e3779b97f4a7c15n];
let pass = 0, fail = 0;
for (let n = 1n; n <= 40n; n++) for (const seed of seeds) {
  // oracle: interpreter
  const e = mk(); const cpu = e.cpu;
  for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
  const rsp = ((e.base + BigInt(e.ram.length) - 4096n) & ~0xFn) - 8n;
  cpu.regs[4] = rsp; cpu.regs[7] = n; cpu.regs[6] = seed;      // rdi=n, rsi=seed
  e.mem.write(rsp, 8n, SENT); cpu.rip = entry;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 1e6) throw new Error('runaway'); }
  const oracle = BigInt.asUintN(64, cpu.regs[0]);

  // AOT
  const e2 = mk();
  const inst = new WebAssembly.Instance(mod, { js: { mem: e2.wmem }, env: e2.aotEnv() });
  for (let r = 0; r < 16; r++) e2.regview[r] = 0n;
  e2.regview[4] = BigInt.asIntN(64, rsp); e2.regview[7] = BigInt.asIntN(64, n); e2.regview[6] = BigInt.asIntN(64, seed);
  new DataView(e2.wmem.buffer).setBigUint64(e2.RAMOFF + Number(rsp - e2.base), SENT, true);
  const exit = BigInt.asUintN(64, inst.exports[entryName]());
  if (exit !== SENT) { fail++; console.log(`FAIL exit n=${n} seed=${seed.toString(16)} exit=${exit.toString(16)}`); continue; }
  const aot = BigInt.asUintN(64, e2.regview[0]);
  if (aot === oracle) pass++;
  else { fail++; console.log(`MISMATCH n=${n} seed=${seed.toString(16)}: oracle=${oracle.toString(16)} aot=${aot.toString(16)}`); }
}
console.log(`\n${pass}/${pass + fail} dispatch-mode (irreducible CFG) results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
