// Differential: stmxcsr/ldmxcsr translated rather than escaped.
//
// MXCSR is inert in this engine - the interpreter stores and loads it and no
// arithmetic consults it - so a unit can run the round trip itself. The reason
// it matters is not the two instructions: a unit whose ENTRY decodes to a
// deopt is refused ENTIRELY, and glibc's libm opens several math functions
// with `stmxcsr`. One of them ran 31,307 times interpreted in the ffprobe
// case, and the sweep called that case exact the whole time, because it was.
//
// The invariant is the usual one: whatever the translator accepts must agree
// with the interpreter, over a range of control words rather than the default.
import { compileFunctionWat, MXCSR_SLOT } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, DATA = 0x400800n, SENT = 0xdeadbee0n;
const CASES = [
  // read it, write it back, read it again: the value must survive the trip
  ['roundtrip', `mov rax, 0x400800
stmxcsr [rax]
ldmxcsr [rax]
stmxcsr [rax+8]
mov rax, [rax+8]
ret`],
  // load a value the guest chose, then read it back
  ['set-then-get', `mov rax, 0x400800
mov dword [rax+16], esi
ldmxcsr [rax+16]
stmxcsr [rax+24]
mov rax, [rax+24]
ret`],
  // a math-function preamble: save, mask, restore, and keep working after
  ['libm-preamble', `mov rax, 0x400800
stmxcsr [rax]
mov ecx, [rax]
and ecx, 0xffff9fff
mov [rax+8], ecx
ldmxcsr [rax+8]
add rdi, 1
ldmxcsr [rax]
mov rax, rdi
ret`],
];
const WORDS = [0x1f80, 0x0000, 0x9fc0, 0x7fff, 0x6000];

let pass = 0, fail = 0;
for (const [name, body] of CASES) {
  writeFileSync('/tmp/mx.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/mx.bin', '/tmp/mx.asm']);
  const b = readFileSync('/tmp/mx.bin'); const code = new Uint8Array(0x1000); code.set(b);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { fail++; console.log(`  REFUSED ${name}: ${e.message}`); continue; }
  writeFileSync('/tmp/mx.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/mx.wat', '-o', '/tmp/mx.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/mx.wasm'));
  for (const w of WORDS) for (const arg of [0n, 7n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.mxcsr = w; cpu.regs[7] = arg; cpu.regs[6] = BigInt(w ^ 0x40);
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 300) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]), oracleMx = cpu.mxcsr;

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
    dv.setUint32(MXCSR_SLOT, w, true);          // what syncOut leaves for the unit
    inst.exports[r.entryName]();
    const aot = BigInt.asUintN(64, rv[0]), aotMx = dv.getUint32(MXCSR_SLOT, true);
    // both the value the function returns AND the control word it leaves
    // behind, since syncIn hands the latter back to the interpreter
    if (aot === oracle && aotMx === oracleMx) pass++;
    else { fail++; if (fail <= 6) console.log(`  MISMATCH ${name} mxcsr=0x${w.toString(16)} rdi=${arg}: oracle=${oracle}/0x${oracleMx.toString(16)} aot=${aot}/0x${aotMx.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} stmxcsr/ldmxcsr results bit-exact (AOT vs interpreter), control word included`);
if (fail) process.exit(1);
