// Differential test for cross-block lazy flags: a flag producer (cmp/sub/test)
// in one basic block feeding a consumer (jcc / setcc / cmov) in another block.
// The reaching-definition analysis must materialize the producer and give the
// consumer the right cond() form. Checked bit-exact vs the interpreter oracle.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/xf.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/xf.bin', '/tmp/xf.asm']);
  const b = readFileSync('/tmp/xf.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};

// Each case: a function where flags cross a block boundary. `cc` picks the
// condition; the producer sits at the end of block 0, the consumer at the top
// of block 1 (reached via an unconditional jmp so a leader splits them).
const CASES = [
  // signed compares (cmp) consumed cross-block
  ['cmp-jl',  `cmp rdi, rsi
jmp c
c: jl t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['cmp-jg',  `cmp rdi, rsi
jmp c
c: jg t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['cmp-jbe', `cmp rdi, rsi
jmp c
c: jbe t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['cmp-jne', `cmp rdi, rsi
jmp c
c: jne t
mov rax, 1
ret
t: mov rax, 2
ret`],
  // test (logic) consumed cross-block
  ['test-js', `test rdi, rdi
jmp c
c: js t
mov rax, 1
ret
t: mov rax, 2
ret`],
  ['test-jz', `test rdi, rdi
jmp c
c: jz t
mov rax, 1
ret
t: mov rax, 2
ret`],
  // sub (sub-kind) then a setcc cross-block, plus a merge: two producers of the
  // same (kind,size) reaching one consumer.
  ['merge',   `cmp rdi, rsi
jg hi
cmp rdi, rsi
jmp m
hi: cmp rsi, rdi
jmp m
m: setl al
movzx rax, al
ret`],
  // cmov consuming a cross-block producer
  ['cmov',    `cmp rdi, rsi
jmp c
c: mov rax, rdi
cmovl rax, rsi
ret`],
];

const vals = [-100n, -3n, -1n, 0n, 1n, 2n, 5n, 100n, 0x7fffffffffffffffn, -0x8000000000000000n];
let pass = 0, fail = 0, compiled = 0;
for (const [name, body] of CASES) {
  const code = asm(body);
  let mod, entryName;
  try {
    const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
    writeFileSync('/tmp/xf.wat', r.wat); execFileSync('wat2wasm', ['/tmp/xf.wat', '-o', '/tmp/xf.wasm']);
    mod = new WebAssembly.Module(readFileSync('/tmp/xf.wasm')); entryName = r.entryName; compiled++;
  } catch (e) { fail++; console.log(`COMPILE-FAIL ${name}: ${e.message}`); continue; }
  for (const a of vals) for (const b of vals) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
    cpu.regs[7] = BigInt.asUintN(64, a); cpu.regs[6] = BigInt.asUintN(64, b);   // rdi, rsi
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 1000) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16);
    for (let r = 0; r < 16; r++) rv[r] = 0n;
    rv[7] = a; rv[6] = b; rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(mem.buffer).setBigUint64(Number(CODE + 0x800n - CODE), SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[entryName]());
    if (exit !== SENT) { fail++; console.log(`EXIT-FAIL ${name} a=${a} b=${b} exit=${exit.toString(16)}`); continue; }
    const aot = BigInt.asUintN(64, rv[0]);
    if (aot === oracle) pass++;
    else { fail++; console.log(`MISMATCH ${name} a=${a} b=${b}: oracle=${oracle} aot=${aot}`); }
  }
}
console.log(`\n${compiled}/${CASES.length} cross-block-flag functions compiled (not poisoned)`);
console.log(`${pass}/${pass + fail} cross-block-flag results bit-exact (AOT vs interpreter)`);
if (fail || compiled !== CASES.length) process.exit(1);
