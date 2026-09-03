// Regression test for the entry-flag hole: a unit whose ENTRY is a loop head
// (back-edge tier-up) where a flag consumer in the entry block has no in-unit
// producer on the first iteration — its flags come from OUTSIDE the unit.
// The reaching-definition analysis used to bind such a consumer to the
// previous iteration's producer (reached via the back edge), silently reading
// uninitialized flag locals on every dispatch (the pango glyph-cluster
// corruption in GIMP). These units must be POISONED to the interpreter.
// A loop head whose entry block produces its own flags must still compile.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, ENTRY_OFF = 0x40n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/ef.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/ef.bin', '/tmp/ef.asm']);
  const b = readFileSync('/tmp/ef.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};

// Prefix (before the padding) runs only in the interpreter; the compile entry
// is the loop head at CODE+0x40, exactly like a back-edge tier-up slice.
const CASES = [
  // adc at the loop head consumes CF: iteration 1's CF comes from outside.
  ['adc-carry-in', true, `mov rax, rdi
stc
times 0x40-($-$$) nop
lh: adc rax, rsi
sub rcx, 1
jnz lh
ret`],
  // jcc first in the entry block, producer only via the back edge.
  ['jcc-at-entry', true, `mov rax, rdi
cmp rax, rdx
times 0x40-($-$$) nop
lh: jae done
add rax, rsi
cmp rax, rdx
jb lh
done: ret`],
  // Control: entry block has its own producer before the consumer — compiles.
  ['own-producer', false, `mov rax, rdi
times 0x40-($-$$) nop
lh: cmp rax, rdx
jae done
add rax, rsi
jmp lh
done: ret`],
];

let pass = 0, fail = 0;
for (const [name, wantPoison, body] of CASES) {
  const code = asm(body);
  let r = null, err = null;
  try {
    r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE + ENTRY_OFF, { guestBase: CODE, ramBase: 0 });
  } catch (e) { err = e; }
  if (wantPoison) {
    if (err) { pass++; continue; }
    fail++; console.log(`FAIL ${name}: compiled but must be poisoned (entry-live flags)`);
    continue;
  }
  if (err) { fail++; console.log(`FAIL ${name}: poisoned but should compile: ${err.message}`); continue; }
  // control: differential vs interpreter from the loop-head entry
  writeFileSync('/tmp/ef.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/ef.wat', '-o', '/tmp/ef.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/ef.wasm'));
  for (const [a, s, d] of [[5n, 3n, 50n], [0n, 1n, 10n], [100n, 7n, 100n], [1n, 1n, 4n]]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[0] = a; cpu.regs[6] = s; cpu.regs[2] = d;
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE + ENTRY_OFF;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 10000) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[0] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, s); rv[2] = BigInt.asIntN(64, d);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(mem.buffer).setBigUint64(0x800, SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[r.entryName]());
    const aot = BigInt.asUintN(64, rv[0]);
    if (exit === SENT && aot === oracle) pass++;
    else { fail++; console.log(`MISMATCH ${name} a=${a}: oracle=${oracle} aot=${aot} exit=${exit.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} entry-flag cases correct (poison + differential)`);
if (fail) process.exit(1);
