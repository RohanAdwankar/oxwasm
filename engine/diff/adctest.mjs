// Differential test for adc/sbb: the canonical 128-bit add/sub (low op sets CF,
// high op is add/sub-with-carry), across operand extremes, checking the result
// words AND every condition code on the carry op, bit-exact vs the interpreter.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const CCS = ['o','no','b','ae','e','ne','be','a','s','ns','l','ge','le','g'];
// 128-bit add: rdx:rdi += rcx:rsi ; 128-bit sub: rdx:rdi -= rcx:rsi. Flag from the carry op.
const build = (lo, hi, cc) => {
  const asm = `BITS 64\n${lo} rdi, rsi\n${hi} rdx, rcx\nset${cc} al\nmovzx eax, al\nret`;
  writeFileSync('/tmp/ac.asm', asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/ac.bin', '/tmp/ac.asm']);
  const b = readFileSync('/tmp/ac.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};
const V = [0n, 1n, 2n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn,
  0xfffffffffffffffen, 0x123456789abcdefn, 0x80000000n];

let pass = 0, fail = 0;
for (const [lo, hi] of [['add','adc'], ['sub','sbb']]) {
  for (const cc of CCS) {
    const code = build(lo, hi, cc);
    let mod, entryName;
    try {
      const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
      if (r.wat.includes('(call $x_callout') || r.wat.includes('(drop (call $x_callout')) { fail++; console.log(`POISONED ${lo}/${hi}.${cc}`); continue; }
      writeFileSync('/tmp/ac.wat', r.wat); execFileSync('wat2wasm', ['/tmp/ac.wat', '-o', '/tmp/ac.wasm']);
      mod = new WebAssembly.Module(readFileSync('/tmp/ac.wasm')); entryName = r.entryName;
    } catch (e) { fail++; console.log(`COMPILE-FAIL ${lo}/${hi}.${cc}: ${e.message}`); continue; }
    // rdi=aLo, rsi=bLo, rdx=aHi, rcx=bHi
    for (const aLo of V) for (const bLo of [0n, 1n, 0xffffffffffffffffn, 0x8000000000000000n])
    for (const aHi of [0n, 5n, 0xffffffffffffffffn, 0x7fffffffffffffffn, 0x8000000000000000n]) {
      const bHi = 3n;
      const m = new Memory([{ base: CODE, bytes: code.slice() }]);
      const cpu = new CPU(m);
      for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
      cpu.regs[7] = aLo; cpu.regs[6] = bLo; cpu.regs[2] = aHi; cpu.regs[1] = bHi;   // rdi rsi rdx rcx
      cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 100) throw new Error('runaway'); }
      const oRax = BigInt.asUintN(64, cpu.regs[0]), oRdi = BigInt.asUintN(64, cpu.regs[7]), oRdx = BigInt.asUintN(64, cpu.regs[2]);

      const mem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
      const rv = new BigInt64Array(mem.buffer, 0, 16);
      for (let r = 0; r < 16; r++) rv[r] = 0n;
      rv[7] = BigInt.asIntN(64, aLo); rv[6] = BigInt.asIntN(64, bLo); rv[2] = BigInt.asIntN(64, aHi); rv[1] = BigInt.asIntN(64, bHi); rv[4] = BigInt.asIntN(64, CODE + 0x800n);
      new DataView(mem.buffer).setBigUint64(Number(0x800n), SENT, true);
      const exit = BigInt.asUintN(64, inst.exports[entryName]());
      if (exit !== SENT) { fail++; console.log(`EXIT-FAIL ${lo}/${hi}.${cc}`); continue; }
      const wRax = BigInt.asUintN(64, rv[0]), wRdi = BigInt.asUintN(64, rv[7]), wRdx = BigInt.asUintN(64, rv[2]);
      if (wRax === oRax && wRdi === oRdi && wRdx === oRdx) pass++;
      else { fail++; console.log(`MISMATCH ${lo}/${hi}.${cc} aLo=${aLo.toString(16)} bLo=${bLo.toString(16)} aHi=${aHi.toString(16)}: oracle rax=${oRax} rdi=${oRdi.toString(16)} rdx=${oRdx.toString(16)} | aot rax=${wRax} rdi=${wRdi.toString(16)} rdx=${wRdx.toString(16)}`); }
    }
  }
}
console.log(`\n${pass}/${pass + fail} adc/sbb (128-bit add/sub) results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
