// Differential: bsf/bsr destination behaviour vs the real CPU, in BOTH tiers.
//
// Intel documents the destination as undefined when the source is zero; real
// Intel and AMD silicon leave it UNMODIFIED, and glibc's hand-written string
// asm depends on that: __memrchr does `bsr %eax,%eax; je ret`, returning the
// untouched rax as its not-found NULL. The AOT emitter wrote 31-clz(0) = -1
// into the destination instead, that 0xffffffff went back to CPython as a
// "found" pointer, str.rpartition computed a negative length from it, and
// import failed under the AOT tier ("Negative size passed to PyUnicode_New").
//
// Part 1 pins the silicon behaviour itself via ./stepper - including the
// zero-source destination preservation the docs refuse to promise. Part 2
// pins AOT == interpreter on the same cases.
import { runCase } from './run.mjs';
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const SRCS = [0n, 1n, 0x8000n, 0x80000000n, 0x8000000000000000n, 0xF0F0F0F0F0F0F0n];
const FORMS = [['r64', 'rcx, rax'], ['r32', 'ecx, eax'], ['r16', 'cx, ax']];
const body = (op, form, v) =>
  `mov rax, 0x${v.toString(16)}\nmov rcx, 0x1122334455667788\n${op} ${form}\nsetz bl\n`;

// part 1: interpreter vs hardware (stepper), zero-source cases included
let hwPass = 0, hwFail = 0;
for (const op of ['bsf', 'bsr'])
  for (const [w, form] of FORMS)
    for (const v of SRCS) {
      // ZF is the only flag bsf/bsr DEFINE; silicon sets the rest to
      // model-specific values the interpreter does not chase. The setz in the
      // body materialises ZF into a register, which is compared regardless.
      const r = runCase(`${op}-${w}-src=${v.toString(16)}`,
                        body(op, form, v) + 'self: jmp self', { maxSteps: 8, flagMask: 0x40n });
      if (r.ok) hwPass++; else { hwFail++; console.log(`HW MISMATCH ${op} ${w} src=${v.toString(16)}: ${r.err ?? ''}`); }
    }
console.log(`\n${hwPass}/${hwPass + hwFail} bsf/bsr cases bit-exact vs hardware (interpreter)`);

// part 2: AOT vs interpreter on the same cases
const CODE = 0x400000n, SENT = 0xdeadbee0n;
let pass = 0, fail = 0, skip = 0;
for (const op of ['bsf', 'bsr'])
  for (const [w, form] of FORMS)
    for (const v of SRCS) {
      writeFileSync('/tmp/bsr.asm', 'BITS 64\n' + body(op, form, v) + 'ret\n');
      execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/bsr.bin', '/tmp/bsr.asm']);
      const bin = readFileSync('/tmp/bsr.bin');
      const code = new Uint8Array(0x10000); code.set(bin);
      let r;
      try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
      catch (e) { skip++; console.log(`SKIP ${op} ${w}: ${e.message}`); continue; }
      writeFileSync('/tmp/bsr.wat', r.wat);
      execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/bsr.wat', '-o', '/tmp/bsr.wasm']);
      const mod = new WebAssembly.Module(readFileSync('/tmp/bsr.wasm'));

      const m = new Memory([{ base: CODE, bytes: code.slice() }]);
      const cpu = new CPU(m);
      for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
      cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 30) throw new Error('runaway'); }
      const want = [0, 3, 1].map(i => BigInt.asUintN(64, cpu.regs[i]));   // rax, rbx, rcx

      const wmem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
      const rv = new BigInt64Array(wmem.buffer, 0, 16);
      for (let i = 0; i < 16; i++) rv[i] = 0n;
      rv[4] = BigInt.asIntN(64, CODE + 0x800n);
      new DataView(wmem.buffer).setBigUint64(0x800, SENT, true);
      inst.exports[r.entryName]();
      const got = [0, 3, 1].map(i => BigInt.asUintN(64, rv[i]));
      if (got.every((x, i) => x === want[i])) pass++;
      else { fail++;
        console.log(`AOT MISMATCH ${op} ${w} src=${v.toString(16)}: interp rax,rbx,rcx=${want.map(x=>x.toString(16))} aot=${got.map(x=>x.toString(16))}`); }
    }
console.log(`${pass}/${pass + fail} bsf/bsr results bit-exact (AOT vs interpreter)` + (skip ? `, ${skip} unsupported forms skipped` : ''));
if (hwFail || fail) process.exit(1);
