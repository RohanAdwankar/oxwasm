// Differential test for add/sub flag reconstruction in the AOT: every
// condition code (including the newly-added CF/OF forms) after add/sub, over
// operand extremes and both widths, checked bit-exact against the interpreter.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const CCS = ['o','no','b','ae','e','ne','be','a','s','ns','l','ge','le','g'];
const build = (mnem, cc, reg) => {
  const asm = `BITS 64\n${mnem} ${reg[0]}, ${reg[1]}\nset${cc} al\nmovzx eax, al\nret`;
  writeFileSync('/tmp/af.asm', asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/af.bin', '/tmp/af.asm']);
  const b = readFileSync('/tmp/af.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};
const vals64 = [0n, 1n, 2n, 0x7fffffffffffffffn, 0x8000000000000000n, 0xffffffffffffffffn,
  0xfffffffffffffffen, 0x123456789abcdefn, 5n, 0x80000000n, 0xffffffffn];
const vals32 = [0n, 1n, 2n, 0x7fffffffn, 0x80000000n, 0xffffffffn, 0xfffffffen, 5n, 100n, 0x40000000n];

let pass = 0, fail = 0;
for (const mnem of ['add', 'sub'])
for (const [regs, vals, S] of [[['rdi','rsi'], vals64, 8], [['edi','esi'], vals32, 4]]) {
  for (const cc of CCS) {
    const code = build(mnem, cc, regs);
    let mod, entryName;
    try {
      const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
      writeFileSync('/tmp/af.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/af.wat', '-o', '/tmp/af.wasm']);
      mod = new WebAssembly.Module(readFileSync('/tmp/af.wasm')); entryName = r.entryName;
    } catch (e) { fail++; console.log(`COMPILE-FAIL ${mnem}.${cc}.S${S}: ${e.message}`); continue; }
    for (const a of vals) for (const b of vals) {
      const m = new Memory([{ base: CODE, bytes: code.slice() }]);
      const cpu = new CPU(m);
      for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
      cpu.regs[7] = a; cpu.regs[6] = b;                          // rdi, rsi
      cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 100) throw new Error('runaway'); }
      const oracle = BigInt.asUintN(64, cpu.regs[0]);

      const mem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
      const rv = new BigInt64Array(mem.buffer, 0, 16);
      for (let r = 0; r < 16; r++) rv[r] = 0n;
      rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b); rv[4] = BigInt.asIntN(64, CODE + 0x800n);
      new DataView(mem.buffer).setBigUint64(Number(0x800n), SENT, true);
      const exit = BigInt.asUintN(64, inst.exports[entryName]());
      if (exit !== SENT) { fail++; console.log(`EXIT-FAIL ${mnem}.${cc}.S${S}`); continue; }
      const aot = BigInt.asUintN(64, rv[0]);
      if (aot === oracle) pass++;
      else { fail++; console.log(`MISMATCH ${mnem}.${cc}.S${S} a=${a.toString(16)} b=${b.toString(16)}: oracle=${oracle} aot=${aot}`); }
    }
  }
}
console.log(`\n${pass}/${pass + fail} add/sub condition-code results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
