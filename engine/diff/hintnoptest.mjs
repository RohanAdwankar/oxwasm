// 0F 18-1F hint-nop family (prefetcht0/1/2/nta, prefetchw, long nop):
// architectural no-ops with a full modrm. Regression: the decoder rejected
// 0F 18, which faulted GIMP's image-buffer initialization (pixman's
// prefetching memset) the moment a new image was created.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/hnop.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/hnop.bin', '/tmp/hnop.asm']);
  const b = readFileSync('/tmp/hnop.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};
const CASES = [
  ['prefetcht0',  `mov rax, rdi
prefetcht0 [rax]
add rax, rsi
ret`],
  ['prefetchnta', `mov rax, rdi
prefetchnta [rax + rsi*8 + 0x40]
add rax, rsi
ret`],
  ['prefetchw',   `mov rax, rdi
prefetchw [rax + 0x100]
add rax, rsi
ret`],
  ['longnop',     `mov rax, rdi
db 0x0f, 0x1f, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00
add rax, rsi
ret`],
  ['hint1a',      `mov rax, rdi
db 0x0f, 0x1a, 0x00
add rax, rsi
ret`],
];
const vals = [0x400100n, 0x400200n, 0x4008f0n];
let pass = 0, fail = 0;
for (const [name, body] of CASES) {
  const code = asm(body);
  const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/hnop.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/hnop.wat', '-o', '/tmp/hnop.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/hnop.wasm'));
  for (const a of vals) for (const b of [0n, 7n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[7] = a; cpu.regs[6] = b;
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 100) throw new Error('runaway'); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);
    const want = BigInt.asUintN(64, a + b);
    if (oracle !== want) { console.log(`FAIL interp ${name} a=${a} b=${b}: ${oracle} != ${want}`); fail++; continue; }
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(mem.buffer).setBigUint64(0x800, SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[r.entryName]());
    const got = BigInt.asUintN(64, rv[0]);
    if (exit === SENT && got === oracle) pass++;
    else { console.log(`FAIL aot ${name} a=${a} b=${b}: ${got} != ${oracle}`); fail++; }
  }
}
console.log(`${pass}/${pass + fail} hint-nop/prefetch results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
