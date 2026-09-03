// lea operand-size semantics: 32-bit lea truncates the effective address to
// 32 bits and zero-extends into the 64-bit register (regression: the AOT used
// to store the raw 64-bit address — a negative displacement left the high
// bits set, which corrupted pango's Unicode table indexing in GIMP).
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/lea.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/lea.bin', '/tmp/lea.asm']);
  const b = readFileSync('/tmp/lea.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};
const CASES = [
  ['lea32-negdisp', `lea ecx, [rdi - 0xd7b0]
mov rax, rcx
ret`],
  ['lea32-index',   `lea eax, [rdi + rsi*4 + 0x10]
ret`],
  ['lea64-negdisp', `lea rax, [rdi - 0x20]
ret`],
  ['lea16',         `mov rcx, rdx
lea cx, [rdi + 0x7fff]
mov rax, rcx
ret`],
];
const vals = [0n, 1n, 0x6dn, 0x21026d2n, 0xffffffffn, 0x100000000n, 0x7fffffffffffffffn];
let pass = 0, fail = 0;
for (const [name, body] of CASES) {
  const code = asm(body);
  const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/lea.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/lea.wat', '-o', '/tmp/lea.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/lea.wasm'));
  for (const a of vals) for (const b of [0n, 3n, 0x123n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[7] = a; cpu.regs[6] = b; cpu.regs[2] = 0xAAAA5555AAAA5555n;
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 100) throw new Error('runaway'); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b); rv[2] = BigInt.asIntN(64, 0xAAAA5555AAAA5555n);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(mem.buffer).setBigUint64(0x800, SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[r.entryName]());
    const aot = BigInt.asUintN(64, rv[0]);
    if (exit === SENT && aot === oracle) pass++;
    else { fail++; console.log(`MISMATCH ${name} rdi=${a.toString(16)} rsi=${b}: oracle=${oracle.toString(16)} aot=${aot.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} lea size-semantics results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
