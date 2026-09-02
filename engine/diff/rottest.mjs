// Differential test: rol/ror at all widths. i32.rotl only implements the
// 32-bit form — byte and word rotates must wrap within their own width
// (expat's BOM detect does rol $8,%dx and got its bytes thrown into bits
// 16+, so every XML file "failed to parse" once that unit tiered up).
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const CODE = 0x400000n, SENT = 0xdeadbee0n;
const REGS = { 1:'dl', 2:'dx', 4:'edx', 8:'rdx' };
const VALS = [0x123456789ABCDEF6n, 0xBBEFn, 0x80n, 0xFFFFFFFFFFFFFFFFn, 1n];
let pass = 0, fail = 0;
for (const op of ['rol', 'ror']) for (const w of [1,2,4,8]) for (const cnt of [0,1,7,8,13,31]) {
  if (cnt >= w*8) continue;
  writeFileSync('/tmp/rt.asm', `BITS 64\n${op} ${REGS[w]}, ${cnt}\nret\n`);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/rt.bin', '/tmp/rt.asm']);
  const bin = readFileSync('/tmp/rt.bin'); const code = new Uint8Array(0x1000); code.set(bin);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { console.log(`SKIP ${op}${w}/${cnt}: ${e.message}`); fail++; continue; }
  writeFileSync('/tmp/rt.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/rt.wat', '-o', '/tmp/rt.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/rt.wasm'));
  for (const v of VALS) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]); const cpu = new CPU(m);
    for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
    cpu.regs[2] = v;
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 20) throw new Error('runaway'); }
    const want = BigInt.asUintN(64, cpu.regs[2]);
    const wmem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(wmem.buffer, 0, 16);
    for (let i = 0; i < 16; i++) rv[i] = 0n;
    rv[2] = BigInt.asIntN(64, v); rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(wmem.buffer).setBigUint64(0x800, SENT, true);
    inst.exports[r.entryName]();
    const got = BigInt.asUintN(64, rv[2]);
    if (got === want) pass++;
    else { fail++; if (fail <= 6) console.log(`MISMATCH ${op} w${w} c${cnt} v=${v.toString(16)}: interp=${want.toString(16)} aot=${got.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass+fail} rol/ror results bit-exact (AOT vs interpreter)`);

// Unit-mode rol/ror with a MEMORY destination. The unit emitter's S===8
// branch hardcoded `local.set $r<dst.r>`, but `rol qword [mem], n` has no
// register dst - dst.r is undefined, so it emitted `$rundefined`, which
// wat2wasm rejects, silently dropping the whole unit to interp. cc1's switch
// dispatch rotates jump-table words in place and hit exactly this.
{ const { compileUnitWat } = await import('../aot_wat.mjs');
  let mpass = 0, mfail = 0;
  writeFileSync('/tmp/rm.asm', 'BITS 64\nrol qword [rdi], 5\nror qword [rdi+8], 3\nrol qword [rdi+16], 40\nret\n');
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/rm.bin', '/tmp/rm.asm']);
  const code = new Uint8Array(0x1000); code.set(readFileSync('/tmp/rm.bin'));
  const u = compileUnitWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  if (/\$rundefined/.test(u.wat)) { console.log('rol/ror [mem]: emitted $rundefined (unit dropped to interp)'); process.exit(1); }
  writeFileSync('/tmp/rm.wat', u.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/rm.wat', '-o', '/tmp/rm.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/rm.wasm'));
  const entry = 'f_' + CODE.toString(16);
  for (const seed of [0x123456789ABCDEF6n, 1n, 0xFFFFFFFFFFFFFFFFn, 0x80n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]); const cpu = new CPU(m);
    for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
    const BUF = CODE + 0x600n;
    cpu.regs[7] = BUF; for (let k = 0; k < 3; k++) m.write(BUF + BigInt(k*8), 8n, seed + BigInt(k));
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 40) throw new Error('runaway'); }
    const want = [0,1,2].map(k => BigInt.asUintN(64, m.read(BUF + BigInt(k*8), 8n)));

    const wmem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(wmem.buffer, 0, 16);
    for (let i = 0; i < 16; i++) rv[i] = 0n;
    const dv = new DataView(wmem.buffer);
    rv[7] = BigInt.asIntN(64, BUF); for (let k = 0; k < 3; k++) dv.setBigUint64(Number(BUF - CODE) + k*8, seed + BigInt(k), true);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n); dv.setBigUint64(Number(0x800n), SENT, true);
    inst.exports[entry]();
    const got = [0,1,2].map(k => dv.getBigUint64(Number(BUF - CODE) + k*8, true));
    if (got.every((v, i) => v === want[i])) mpass++;
    else { mfail++; console.log(`MEM MISMATCH seed=${seed.toString(16)}: interp=${want.map(x=>x.toString(16))} aot=${got.map(x=>x.toString(16))}`); }
  }
  console.log(`${mpass}/${mpass+mfail} rol/ror [mem64] bit-exact (unit AOT vs interpreter)`);
  if (mfail) process.exit(1);
}
if (fail) process.exit(1);
