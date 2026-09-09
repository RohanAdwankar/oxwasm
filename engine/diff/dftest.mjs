// Differential: the direction flag crossing the unit boundary.
//
// std and cld are one bit each, and the emitter treated them as nothing: cld
// was a no-op and std threw "unhandled", which refused every function
// containing one (2,232 calls in the go-version case). Both are wrong in the
// same way. A unit that runs `std` and then returns leaves the guest expecting
// DF=1; a unit that runs `cld` must actually clear a DF its caller set.
//
// The string ops still refuse in any function containing `std` - they are
// written assuming a forward copy - so this is only about the flag reaching
// the interpreter, which is what the test checks: run the unit, then read the
// flag back the way syncIn does.
import { compileFunctionWat, DF_SLOT } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/df.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/df.bin', '/tmp/df.asm']);
  const b = readFileSync('/tmp/df.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};

const CASES = [
  ['std',        'std\nmov rax, 1\nret'],
  ['cld',        'cld\nmov rax, 1\nret'],
  ['std-cld',    'std\ncld\nmov rax, 1\nret'],
  ['cld-std',    'cld\nstd\nmov rax, 1\nret'],
  // set it on one arm only, so the flag depends on the path taken
  ['branch-std', 'test rdi, rdi\njz skip\nstd\nskip:\nmov rax, 1\nret'],
  ['branch-cld', 'test rdi, rdi\njz skip\ncld\nskip:\nmov rax, 1\nret'],
];

let pass = 0, fail = 0, refused = 0;
for (const [name, body] of CASES) {
  const code = asm(body);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${name}: ${e.message.slice(0, 60)}`); continue; }
  writeFileSync('/tmp/df.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/df.wat', '-o', '/tmp/df.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/df.wasm'));
  // both incoming values of DF, because a no-op cld only shows up when DF was
  // already set, and a no-op std only when it was already clear
  for (const dfIn of [0, 1]) for (const arg of [0n, 1n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.f.df = dfIn; cpu.regs[7] = arg;
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 200) throw new Error('runaway ' + name); }
    const oracle = cpu.f.df ? 1 : 0;

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = BigInt.asIntN(64, arg);
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    dv.setUint32(DF_SLOT, dfIn, true);          // what syncOut leaves for the unit
    inst.exports[r.entryName]();
    const aot = dv.getUint32(DF_SLOT, true) ? 1 : 0;   // what syncIn would read back
    if (aot === oracle) pass++;
    else { fail++; console.log(`  MISMATCH ${name} dfIn=${dfIn} rdi=${arg}: interpreter DF=${oracle} unit left DF=${aot}`); }
  }
}
console.log(`\n${pass}/${pass + fail} direction-flag results match the interpreter across the unit boundary`);
if (refused) console.log(`${refused} refused`);
if (fail || refused) process.exit(1);
