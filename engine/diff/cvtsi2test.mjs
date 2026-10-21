// Differential test for the scalar float -> integer conversions (cvtt/cvt sd/ss2si, 32 and 64 bit), AOT against the interpreter oracle.
// x86 answers the integer indefinite for NaN and for anything out of range; wasm's trunc_sat clamps (and gives 0 for NaN).
import { compileFunctionWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const CODE = 0x400000n, SENT = 0xdeadbee0n;
const { CPU, Memory } = await import('../interp.mjs');
const f64 = (x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return b.readBigUInt64LE(); };
const f32 = (x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return BigInt(b.readUInt32LE()); };
const dvals = [0, -0, 0.5, 1.5, 2.5, -1.5, 2147483647, 2147483647.5, 2147483648, 2147483649, -2147483648, -2147483648.5, -2147483649, 4294967296, 1e10, 4.5e15, 9.2e18, 9223372036854775807, 9223372036854775808, -9223372036854775808, -9.3e18, 1e300, -1e300, Infinity, -Infinity, NaN];
let pass = 0, fail = 0;
for (const [asm, kind] of [['cvttsd2si eax, xmm0', 'd'], ['cvttsd2si rax, xmm0', 'd'], ['cvtsd2si eax, xmm0', 'd'], ['cvtsd2si rax, xmm0', 'd'], ['cvttss2si eax, xmm0', 's'], ['cvttss2si rax, xmm0', 's']]) {
  writeFileSync('/tmp/cs.asm', `BITS 64\n${asm}\nret`); execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/cs.bin', '/tmp/cs.asm']);
  const code = new Uint8Array(0x1000); code.set(new Uint8Array(readFileSync('/tmp/cs.bin')));
  const { wat, entryName } = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 1 << 20 });
  writeFileSync('/tmp/cs.wat', wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/cs.wat', '-o', '/tmp/cs.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/cs.wasm'));
  for (const x of dvals) {
    const bits = kind === 'd' ? f64(x) : f32(x);
    const m = new Memory([{ base: CODE, bytes: code }]); const cpu = new CPU(m);
    for (let r = 0; r < 16; r++) cpu.regs[r] = 0n; cpu.xmm[0] = bits; cpu.regs[0] = 0xAAAAAAAAAAAAAAAAn;
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway'); }
    const o = BigInt.asUintN(64, cpu.regs[0]);
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16); rv[0] = BigInt.asIntN(64, 0xAAAAAAAAAAAAAAAAn); rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(mem.buffer).setBigUint64(256, bits, true);
    new DataView(mem.buffer).setBigUint64(Number(CODE + 0x800n - CODE) + (1 << 20), SENT, true);
    inst.exports[entryName]();
    const a = BigInt.asUintN(64, rv[0]);
    if (a === o) pass++; else { fail++; console.log(`MISMATCH ${asm} x=${x}: oracle=${o.toString(16)} aot=${a.toString(16)}`); }
  }
}
console.log(`${pass}/${pass + fail} scalar float->int conversions match the oracle`);
if (fail) process.exit(1);
