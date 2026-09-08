// Differential: fnstcw/fldcw translated rather than escaped.
//
// The x87 control word is 16 bits of rounding and precision mode. It is not
// the FPU register stack, which units genuinely cannot model - it is the same
// shape as MXCSR, and the emitter already round-trips that through a slot.
// The decoder lumps every D8-DF opcode under one `x87` mnem, so these two rode
// along into the blanket escape.
//
// The cost was not the two instructions. A unit whose ENTRY decodes to a deopt
// is refused ENTIRELY, and glibc's float formatting opens with
// `fnstcw; movzx; and; cmp; jcc` to dispatch on the rounding mode - mawk ran
// that whole function interpreted 1,996 times in one sweep case, and 5,996 in
// another, while the sweep called both cases exact. Because they were.
//
// The invariant is the usual one: whatever the translator accepts must agree
// with the interpreter, across control words rather than only the default.
import { compileFunctionWat, FCW_SLOT } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const CASES = [
  // read it, write it back, read it again: the value must survive the trip
  ['roundtrip', `mov rdx, 0x400800
fnstcw [rdx]
fldcw [rdx]
fnstcw [rdx+8]
movzx rax, word [rdx+8]
ret`],
  // load a word the guest chose, then read it back
  ['set-then-get', `mov rdx, 0x400800
mov [rdx+16], si
fldcw [rdx+16]
fnstcw [rdx+24]
movzx rax, word [rdx+24]
ret`],
  // the glibc shape this was found in: read the mode, branch on it, and keep
  // compiling afterwards. The whole point is that this function translates.
  ['rounding-dispatch', `mov rdx, 0x400800
fnstcw [rdx]
movzx eax, word [rdx]
and ax, 0xc00
cmp ax, 0x800
je up
ja trunc
mov rax, rdi
ret
up: mov rax, rdi
add rax, 1
ret
trunc: mov rax, rdi
add rax, 2
ret`],
  // save, narrow to truncation, restore - the sequence around a float-to-int
  // conversion, and the one place a dropped fldcw would change an answer
  ['save-set-restore', `mov rdx, 0x400800
fnstcw [rdx]
movzx eax, word [rdx]
or eax, 0xc00
mov [rdx+8], ax
fldcw [rdx+8]
add rdi, 1
fldcw [rdx]
mov rax, rdi
ret`],
];
// default, all four rounding modes, and the extremes
const WORDS = [0x037F, 0x0000, 0x0400, 0x0800, 0x0C00, 0x127F, 0xFFFF];

let pass = 0, fail = 0;
for (const [name, body] of CASES) {
  writeFileSync('/tmp/fcw.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/fcw.bin', '/tmp/fcw.asm']);
  const b = readFileSync('/tmp/fcw.bin'); const code = new Uint8Array(0x1000); code.set(b);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { fail++; console.log(`  REFUSED ${name}: ${e.message}`); continue; }
  writeFileSync('/tmp/fcw.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/fcw.wat', '-o', '/tmp/fcw.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/fcw.wasm'));
  for (const w of WORDS) for (const arg of [0n, 7n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.fcw = w; cpu.regs[7] = arg; cpu.regs[6] = BigInt(w ^ 0x40);
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 300) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]), oracleCw = cpu.fcw;

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = arg; rv[6] = BigInt(w ^ 0x40);
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    dv.setUint32(FCW_SLOT, w, true);            // what syncOut leaves for the unit
    inst.exports[r.entryName]();
    const aot = BigInt.asUintN(64, rv[0]), aotCw = dv.getUint32(FCW_SLOT, true);
    // both the value the function returns AND the control word it leaves
    // behind, since syncIn hands the latter back to the interpreter
    if (aot === oracle && aotCw === oracleCw) pass++;
    else { fail++; if (fail <= 6) console.log(`  MISMATCH ${name} fcw=0x${w.toString(16)} rdi=${arg}: oracle=${oracle}/0x${oracleCw.toString(16)} aot=${aot}/0x${aotCw.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} fnstcw/fldcw results bit-exact (AOT vs interpreter), control word included`);
if (fail) process.exit(1);
