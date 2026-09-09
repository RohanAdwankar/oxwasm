// quick 0xC2 differential: all 8 predicates x scalar/packed x ss/sd forms
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const CODE = 0x400000n, SENT = 0xdeadbee0n;
const f64 = (x) => { const b = new ArrayBuffer(8); new DataView(b).setFloat64(0, x, true); return new DataView(b).getBigUint64(0, true); };
const PAIRS = [[1.5, 2.5], [2.5, 1.5], [3.0, 3.0], [NaN, 1.0], [1.0, NaN]];
let pass = 0, fail = 0;
for (const insn of ['cmpsd', 'cmppd', 'cmpss', 'cmpps']) {
  for (let pred = 0; pred < 8; pred++) {
    writeFileSync('/tmp/c2t.asm', `BITS 64\n${insn} xmm0, xmm1, ${pred}\nmovq rax, xmm0\nret\n`);
    execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/c2t.bin', '/tmp/c2t.asm']);
    const bin = readFileSync('/tmp/c2t.bin'); const code = new Uint8Array(0x20000); code.set(bin);
    let r;
    try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
    catch (e) { console.log(`SKIP ${insn}/${pred}: ${e.message}`); fail++; continue; }
    writeFileSync('/tmp/c2t.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/c2t.wat', '-o', '/tmp/c2t.wasm']);
    const mod = new WebAssembly.Module(readFileSync('/tmp/c2t.wasm'));
    for (const [x, y] of PAIRS) {
      const xb = (f64(x) | (f64(8.5) << 64n)), yb = (f64(y) | (f64(8.5) << 64n));
      const m = new Memory([{ base: CODE, bytes: code.slice() }]); const cpu = new CPU(m);
      for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
      cpu.xmm[0] = xb; cpu.xmm[1] = yb;
      cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 60) throw new Error('runaway'); }
      const want = BigInt.asUintN(64, cpu.regs[0]);
      const wmem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem: wmem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
      const rv = new BigInt64Array(wmem.buffer, 0, 16);
      const xvv = new BigInt64Array(wmem.buffer, 256, 32);
      for (let i = 0; i < 16; i++) rv[i] = 0n;
      xvv[0] = BigInt.asIntN(64, xb & ((1n<<64n)-1n)); xvv[1] = BigInt.asIntN(64, xb >> 64n);
      xvv[2] = BigInt.asIntN(64, yb & ((1n<<64n)-1n)); xvv[3] = BigInt.asIntN(64, yb >> 64n);
      rv[4] = BigInt.asIntN(64, CODE + 0x800n);
      new DataView(wmem.buffer).setBigUint64(0x800, SENT, true);
      inst.exports[r.entryName]();
      const got = BigInt.asUintN(64, rv[0]);
      if (got === want) pass++; else { fail++; if (fail <= 5) console.log(`MISMATCH ${insn}/${pred} ${x},${y}: interp=${want.toString(16)} aot=${got.toString(16)}`); }
    }
  }
}
console.log(`${pass}/${pass+fail} cmpps/pd/ss/sd bit-exact`);
process.exit(fail ? 1 : 0);
