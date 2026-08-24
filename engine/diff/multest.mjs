// Differential test for the 64-bit one-operand widening multiply in the AOT
// (mul/imul r64 -> rdx:rax). WASM has no mulhi, so the high word is built from
// 32-bit half-products; this checks it bit-exact against the interpreter oracle
// (itself hardware-verified) across sign boundaries and extremes.
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
const vals = [0n, 1n, 2n, 3n, 10n, 255n, 0x100n, 0xFFFFFFFFn, 0x100000000n,
  0x123456789abcdefn, 0x7FFFFFFFFFFFFFFFn, 0x8000000000000000n, U, U - 1n,
  0xdeadbeefcafef00dn, 0xff51afd7ed558ccdn, 0x9e3779b97f4a7c15n, 12345678901234567n];

let pass = 0, fail = 0;
const { CPU, Memory } = await import('../interp.mjs');
for (const mnem of ['mul', 'imul']) {
  const code = new Uint8Array(0x1000); code.set(build(mnem));
  // the compiled wasm is identical for all operands — build it once
  const { wat, entryName } = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/mt.wat', wat); execFileSync('wat2wasm', ['/tmp/mt.wat', '-o', '/tmp/mt.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/mt.wasm'));
  for (const a of vals) for (const b of vals) {
    // oracle: interpreter
    const m = new Memory([{ base: CODE, bytes: code }]);
    const cpu = new CPU(m);
    for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
    cpu.regs[0] = a; cpu.regs[1] = b;                 // rax=a, rcx=b
    cpu.regs[4] = CODE + 0x800n;                       // rsp in code page scratch
    m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;    // write(addr, size, value)
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 100) throw new Error('runaway'); }
    const oRax = BigInt.asUintN(64, cpu.regs[0]), oRdx = BigInt.asUintN(64, cpu.regs[2]);

    // AOT: run the pre-built function in wasm over a fresh memory image
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16);
    for (let r = 0; r < 16; r++) rv[r] = 0n;
    rv[0] = BigInt.asIntN(64, a); rv[1] = BigInt.asIntN(64, b); rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    // guest stack sentinel: wasm offset = ramBase(0) + (rsp - guestBase)
    new DataView(mem.buffer).setBigUint64(Number(CODE + 0x800n - CODE), SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[entryName]());
    if (exit !== SENT) { fail++; console.log(`FAIL exit ${mnem} a=${a.toString(16)} b=${b.toString(16)} exit=${exit.toString(16)}`); continue; }
    const wRax = BigInt.asUintN(64, rv[0]), wRdx = BigInt.asUintN(64, rv[2]);
    if (wRax === oRax && wRdx === oRdx) pass++;
    else { fail++; console.log(`MISMATCH ${mnem} a=${a.toString(16)} b=${b.toString(16)}: oracle rdx:rax=${oRdx.toString(16)}:${oRax.toString(16)} aot=${wRdx.toString(16)}:${wRax.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} 64-bit mul/imul products bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
