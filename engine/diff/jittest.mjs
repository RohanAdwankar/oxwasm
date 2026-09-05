// Verify tier-1 JIT output == tier-0 interpreter for straight-line blocks.
import { CPU, Memory } from '../interp.mjs';
import { compileBlock } from '../jit.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n;
const blocks = [
  'mov rax, 42\nmov rbx, 100\nadd rax, rbx\nxor rcx, rcx\nor rcx, rax\nsub rbx, 7\nand rax, 0xff',
  'mov r8, 0x1000\nmov r9, 0x2000\nadd r8, r9\nadd r8, r9\nxor r10, r8\nmov rax, r10\nsub rax, 1',
  'mov rdi, -1\nand rdi, 0xffff\nor rsi, rdi\nadd rsi, rsi\nxor rdx, rdx\nsub rdx, rsi',
];

let pass = 0;
for (let bi = 0; bi < blocks.length; bi++) {
  writeFileSync('/tmp/jb.asm', 'BITS 64\n' + blocks[bi]);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/jb.bin', '/tmp/jb.asm']);
  const bin = readFileSync('/tmp/jb.bin');
  const code = new Uint8Array(0x10000); code.set(bin);

  // tier-0 reference
  const cpu = new CPU(new Memory([{ base: CODE, bytes: code }]));
  cpu.rip = CODE;
  for (let r = 0; r < 16; r++) cpu.regs[r] = 0x1111n * BigInt(r + 1);
  while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(bin.length)) cpu.step();
  const ref = cpu.regs.slice();

  // tier-1: compile block to wasm, run it on a shared reg file
  const rmem = new Memory([{ base: CODE, bytes: code }]);
  const blk = compileBlock(rmem, CODE);
  const wmem = new WebAssembly.Memory({ initial: 1 });
  const view = new BigInt64Array(wmem.buffer);
  for (let r = 0; r < 16; r++) view[r] = BigInt.asIntN(64, 0x1111n * BigInt(r + 1));
  const { instance } = await WebAssembly.instantiate(blk.wasm, { js: { mem: wmem } });
  instance.exports.run();

  let ok = true;
  for (let r = 0; r < 16; r++)
    if (BigInt.asUintN(64, view[r]) !== ref[r]) {
      ok = false;
      console.log(`block ${bi} reg ${r}: jit=${BigInt.asUintN(64, view[r]).toString(16)} interp=${ref[r].toString(16)}`);
    }
  if (ok) { pass++; console.log(`block ${bi}: ${blk.count} insns JIT-compiled to ${blk.wasm.length}B wasm, matches interpreter`); }
}
console.log(`\n${pass}/${blocks.length} JIT blocks match tier-0`);
