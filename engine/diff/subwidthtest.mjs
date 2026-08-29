// Differential test: sub-width cmp/sub/add with HIGH-BIT immediates must set
// flags from width-masked operands in the AOT tier. x86 decodes imm8 sign-
// extended; rendering it unmasked made `cmp $0x86,%dl; ja` compare 0xF6
// against 0xFFFF...FF86 unsigned — ja fell through and python's peephole
// switch indexed its jump table at 246, deopting into a garbage target.
// Each case captures all eight signed/unsigned conditions via setcc.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const WIDTHS = [
  ['dl',  'byte', [0x7F, 0x80, 0x86, 0xFF, 0x01]],
  ['dx',  'word', [0x7FFF, 0x8000, 0x8086, 0xFFFF, 0x0001]],
  ['edx', 'dword', [0x7FFFFFFF, 0x80000000, 0x80868086, 0xFFFFFFFF, 0x1]],
];
const VALS = [0x00n, 0x7Fn, 0x80n, 0x86n, 0xF6n, 0xFFn, 0x8000n, 0xFFFFn,
              0x80000000n, 0xFFFFFFFFn, 0x123456789ABCDEF6n];

let pass = 0, fail = 0;
for (const [regName, kw, imms] of WIDTHS) {
  for (const imm of imms) {
    for (const op of ['cmp', 'sub', 'add']) {
      const asm = `BITS 64
${op} ${regName}, ${imm >= 0x80000000 ? imm | 0 : imm}
seta al
setb bl
setae cl
setbe sil
setg dil
setl r8b
setge r9b
setle r10b
sets r11b
ret`;
      writeFileSync('/tmp/sw.asm', asm);
      execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/sw.bin', '/tmp/sw.asm']);
      const bin = readFileSync('/tmp/sw.bin'); const code = new Uint8Array(0x1000); code.set(bin);
      let r;
      try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
      catch (e) { console.log(`SKIP ${op} ${regName}, 0x${imm.toString(16)}: ${e.message}`); continue; }
      writeFileSync('/tmp/sw.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/sw.wat', '-o', '/tmp/sw.wasm']);
      const mod = new WebAssembly.Module(readFileSync('/tmp/sw.wasm'));
      for (const v of VALS) {
        const m = new Memory([{ base: CODE, bytes: code.slice() }]);
        const cpu = new CPU(m);
        for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
        cpu.regs[2] = v;
        cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
        let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 60) throw new Error('runaway'); }
        const want = [0,1,2,3,6,7,8,9,10,11].map(i => BigInt.asUintN(64, cpu.regs[i]));

        const wmem = new WebAssembly.Memory({ initial: 4096 });
        const stub = () => { throw new Error('escape'); };
        const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
        const rv = new BigInt64Array(wmem.buffer, 0, 16);
        for (let i = 0; i < 16; i++) rv[i] = 0n;
        rv[2] = BigInt.asIntN(64, v);
        rv[4] = BigInt.asIntN(64, CODE + 0x800n);
        new DataView(wmem.buffer).setBigUint64(0x800, SENT, true);
        inst.exports[r.entryName]();
        const got = [0,1,2,3,6,7,8,9,10,11].map(i => BigInt.asUintN(64, rv[i]));
        if (got.every((x, i) => x === want[i])) pass++;
        else { fail++;
          if (fail <= 8) console.log(`MISMATCH ${op} ${regName},0x${imm.toString(16)} val=0x${v.toString(16)}: interp=${want.map(x=>x.toString(16))} aot=${got.map(x=>x.toString(16))}`); }
      }
    }
  }
}
console.log(`\n${pass}/${pass + fail} sub-width imm flag results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
