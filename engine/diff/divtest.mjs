// Differential test for the unsigned 128/64 divide in the AOT (div r64 with rdx != 0,
// compiler-rt's __udivmodti4 and dtoa). The quotient/remainder are built from 32-bit digits;
// this checks them bit-exact against the interpreter oracle for dividends that do not overflow.
import { LinuxEngine } from '../linux.mjs';
import { compileFunctionWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
function build(mnem) {
  const asm = `BITS 64\n${mnem} rcx\nret`;
  writeFileSync('/tmp/mt.asm', asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/mt.bin', '/tmp/mt.asm']);
  return new Uint8Array(readFileSync('/tmp/mt.bin'));
}

const U = (1n << 64n) - 1n;
let seed = 12345n; const rnd64 = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) & U; return seed ^ (seed >> 29n); };
const lows = [0n, 1n, 2n, 0xFFFFFFFFn, 0x100000000n, 0x8000000000000000n, U, U - 1n, 0xdeadbeefcafef00dn];
const divs = [1n, 2n, 3n, 7n, 0xFFFFFFFFn, 0x100000000n, 0x100000001n, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, 0x8000000000000001n, U - 1n, U, 0xdeadbeefcafef00dn];
const cases = [];
for (const d of divs) for (const l of lows) for (const h of [0n, 1n, d - 1n, d >> 1n, (d >> 1n) + 1n, d > 2n ? d - 2n : 0n]) if (h < d) cases.push([h, l, d]);
for (let i = 0; i < 3000; i++) { const sh = BigInt(Math.floor(Math.random() * 64)); const d = (rnd64() >> sh) | 1n; if (d === 0n) continue; cases.push([rnd64() % d, rnd64(), d]); }

let pass = 0, fail = 0;
const { CPU, Memory } = await import('../interp.mjs');
const code = new Uint8Array(0x1000); code.set(build('div'));
const { wat, entryName } = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
writeFileSync('/tmp/mt.wat', wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/mt.wat', '-o', '/tmp/mt.wasm']);
const mod = new WebAssembly.Module(readFileSync('/tmp/mt.wasm'));
for (const [h, l, d] of cases) {
  const m = new Memory([{ base: CODE, bytes: code }]);
  const cpu = new CPU(m);
  for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
  cpu.regs[0] = l; cpu.regs[1] = d; cpu.regs[2] = h;     // rax=lo, rcx=divisor, rdx=hi
  cpu.regs[4] = CODE + 0x800n;
  m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 100) throw new Error('runaway'); }
  const oRax = BigInt.asUintN(64, cpu.regs[0]), oRdx = BigInt.asUintN(64, cpu.regs[2]);
  const mem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
  const rv = new BigInt64Array(mem.buffer, 0, 16);
  for (let r = 0; r < 16; r++) rv[r] = 0n;
  rv[0] = BigInt.asIntN(64, l); rv[1] = BigInt.asIntN(64, d); rv[2] = BigInt.asIntN(64, h); rv[4] = BigInt.asIntN(64, CODE + 0x800n);
  new DataView(mem.buffer).setBigUint64(Number(CODE + 0x800n - CODE), SENT, true);
  const exit = BigInt.asUintN(64, inst.exports[entryName]());
  if (exit !== SENT) { fail++; console.log(`FAIL exit h=${h.toString(16)} l=${l.toString(16)} d=${d.toString(16)} exit=${exit.toString(16)}`); continue; }
  const wRax = BigInt.asUintN(64, rv[0]), wRdx = BigInt.asUintN(64, rv[2]);
  if (wRax === oRax && wRdx === oRdx) pass++;
  else { fail++; if (fail < 10) console.log(`MISMATCH h=${h.toString(16)} l=${l.toString(16)} d=${d.toString(16)}: oracle q=${oRax.toString(16)} r=${oRdx.toString(16)} aot q=${wRax.toString(16)} r=${wRdx.toString(16)}`); }
}
console.log(`\n${pass}/${pass + fail} 128/64 divides bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
