// Differential test: push with an rsp-relative MEMORY operand must read the
// slot at the OLD rsp (x86 reads the operand before the push moves rsp).
// glib's g_signal_new_valist forwards stack arguments with `push 0x68(%rsp)`;
// getting this wrong sent code bytes into a callee as a pointer.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
// mirror the glib pattern: two reg pushes then two stack-arg forwards
const asm = `BITS 64
sub rsp, 0x20
mov qword [rsp+0x8], rdi
mov qword [rsp+0x10], rsi
mov qword [rsp+0x18], rdx
push rbx
push rbp
push qword [rsp+0x18]
push qword [rsp+0x18]
pop rax
pop rcx
pop rbp
pop rbx
add rsp, 0x20
ret`;
writeFileSync('/tmp/pm.asm', asm);
execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/pm.bin', '/tmp/pm.asm']);
const bin = readFileSync('/tmp/pm.bin'); const code = new Uint8Array(0x1000); code.set(bin);
const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
writeFileSync('/tmp/pm.wat', r.wat); execFileSync('wat2wasm', ['/tmp/pm.wat', '-o', '/tmp/pm.wasm']);
const mod = new WebAssembly.Module(readFileSync('/tmp/pm.wasm'));

let pass = 0, fail = 0;
const V = [0x1111n, 0x2222n, 0x3333n, 0xdeadbeefcafen, 0n, (1n << 63n)];
for (const a of V) for (const b of V) for (const c of [0x77n, 0xabcdn]) {
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  const cpu = new CPU(m);
  for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
  cpu.regs[7] = a; cpu.regs[6] = b; cpu.regs[2] = c;
  cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 200) throw new Error('runaway'); }
  const oracle = [0, 1, 3, 5].map(i => BigInt.asUintN(64, cpu.regs[i]));

  const mem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(mod, { js: { mem }, env: { syscall: stub, callout: stub, deopt: stub } });
  const rv = new BigInt64Array(mem.buffer, 0, 16);
  for (let i = 0; i < 16; i++) rv[i] = 0n;
  rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b); rv[2] = BigInt.asIntN(64, c);
  rv[4] = BigInt.asIntN(64, CODE + 0x800n);
  new DataView(mem.buffer).setBigUint64(Number(0x800n), SENT, true);
  const exit = BigInt.asUintN(64, inst.exports[r.entryName]());
  const got = [0, 1, 3, 5].map(i => BigInt.asUintN(64, rv[i]));
  if (exit === SENT && got.every((v, i) => v === oracle[i])) pass++;
  else { fail++; console.log(`MISMATCH a=${a.toString(16)}: oracle=${oracle.map(x=>x.toString(16))} got=${got.map(x=>x.toString(16))}`); }
}
console.log(`\n${pass}/${pass + fail} push-mem (stack-arg forwarding) results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
