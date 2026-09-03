// Differential test: cmpxchg / xadd through the AOT vs the interpreter.
// glib's g_atomic (every GObject ref/unref) is lock cmpxchg / lock xadd —
// these poisoned whole gobject units until now. Green threads never preempt
// inside a unit, so LOCK needs no fence; semantics + flags must still be
// exact, including the sub-width accumulator merge on failure.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n, SCRATCH = 0x410000n;
const CASES = [];
for (const [w, reg, acc] of [[1,'bl','al'],[2,'bx','ax'],[4,'ebx','eax'],[8,'rbx','rax']]) {
  CASES.push([`cmpxchg-r${w}`, `cmpxchg ${reg}, ${w===8?'rcx':w===4?'ecx':w===2?'cx':'cl'}\nsete dl\nsetb r8b`]);
  CASES.push([`cmpxchg-m${w}`, `mov rsi, 0x410000\ncmpxchg [rsi], ${w===8?'rcx':w===4?'ecx':w===2?'cx':'cl'}\nsete dl\nsetb r8b`]);
  CASES.push([`xadd-r${w}`, `xadd ${reg}, ${w===8?'rcx':w===4?'ecx':w===2?'cx':'cl'}\nseto dl\nsetc r8b`]);
  CASES.push([`xadd-m${w}`, `mov rsi, 0x410000\nxadd [rsi], ${w===8?'rcx':w===4?'ecx':w===2?'cx':'cl'}\nseto dl\nsetc r8b`]);
}
const VALS = [
  [0x11n, 0x11n, 0x99n],                       // equal -> exchange happens
  [0x11n, 0x22n, 0x99n],                       // unequal -> acc reload
  [0x123456789ABCDE11n, 0xFEDCBA9876540011n, 0x7FFFFFFFFFFFFFFFn],  // high-bit soup
  [0xFFn, 0xFFFFFFFFFFFFFFFFn, 0x80n],
];
let pass = 0, fail = 0;
for (const [name, body] of CASES) {
  writeFileSync('/tmp/at.asm', `BITS 64\n${body}\nret\n`);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/at.bin', '/tmp/at.asm']);
  const bin = readFileSync('/tmp/at.bin'); const code = new Uint8Array(0x20000); code.set(bin);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { console.log(`SKIP ${name}: ${e.message}`); fail++; continue; }
  writeFileSync('/tmp/at.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/at.wat', '-o', '/tmp/at.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/at.wasm'));
  for (const [va, vb, vc] of VALS) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
    cpu.regs[0] = va; cpu.regs[3] = vb; cpu.regs[1] = vc;
    m.write(SCRATCH, 8n, vb);
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 60) throw new Error('runaway'); }
    const want = [0,1,2,3,8].map(i => BigInt.asUintN(64, cpu.regs[i]));
    const wantMem = m.read(SCRATCH, 8n);

    const wmem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem: wmem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(wmem.buffer, 0, 16);
    for (let i = 0; i < 16; i++) rv[i] = 0n;
    rv[0] = BigInt.asIntN(64, va); rv[3] = BigInt.asIntN(64, vb); rv[1] = BigInt.asIntN(64, vc);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    const dv = new DataView(wmem.buffer);
    dv.setBigUint64(0x800, SENT, true);
    dv.setBigUint64(0x10000, vb, true);
    inst.exports[r.entryName]();
    const got = [0,1,2,3,8].map(i => BigInt.asUintN(64, rv[i]));
    const gotMem = dv.getBigUint64(0x10000, true);
    if (got.every((x, i) => x === want[i]) && gotMem === wantMem) pass++;
    else { fail++;
      if (fail <= 6) console.log(`MISMATCH ${name} a=${va.toString(16)} b=${vb.toString(16)}: interp=${want.map(x=>x.toString(16))}/${wantMem.toString(16)} aot=${got.map(x=>x.toString(16))}/${gotMem.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} cmpxchg/xadd results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
