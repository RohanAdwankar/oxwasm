// Verify the superblock loop JIT == tier-0 interpreter, on real loops.
import { CPU, Memory } from '../interp.mjs';
import { compileLoop } from '../jit2.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n;
const loops = [
  // sum 1..N in rax, counter rcx down from N
  ['sum', `mov rax, 0
mov rcx, 1000
top:
add rax, rcx
sub rcx, 1
jnz top`, { rax: 0 }],
  // fibonacci-ish accumulate
  ['acc', `mov rax, 1
mov rbx, 1
mov rcx, 90
top:
add rax, rbx
xor rbx, rax
sub rcx, 1
jnz top`, {}],
  // and/or mixing with a down-counter
  ['mix', `mov rax, 0x123456789
mov rdx, 0xfedcba
mov rcx, 500
top:
add rax, rdx
and rax, 0xffffffffff
xor rdx, rax
sub rcx, 1
jnz top`, {}],
];

let pass = 0;
for (const [name, asm, _] of loops) {
  writeFileSync('/tmp/lp.asm', 'BITS 64\n' + asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/lp.bin', '/tmp/lp.asm']);
  const bin = readFileSync('/tmp/lp.bin');
  const code = new Uint8Array(0x10000); code.set(bin);

  // reference: interpreter runs the whole thing
  const cpu = new CPU(new Memory([{ base: CODE, bytes: code }]));
  cpu.rip = CODE;
  for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
  let steps = 0;
  while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(bin.length) && steps < 1e8) { cpu.step(); steps++; }
  const ref = cpu.regs.slice();

  // JIT: find the loop (skip the mov-init preamble by scanning for the first jcc target region).
  // Compile from the first instruction; the compiler itself locates the backward branch.
  // Our compiler expects the block to BE the loop; run the preamble on the interpreter,
  // then hand the loop body to the JIT starting at the loop top.
  // Locate loop top = branch target by decoding.
  const rmem = new Memory([{ base: CODE, bytes: code }]);
  // run preamble (everything before the loop top) on a fresh cpu, then JIT the loop
  const cpu2 = new CPU(new Memory([{ base: CODE, bytes: code }]));
  cpu2.rip = CODE; for (let r = 0; r < 16; r++) cpu2.regs[r] = 0n;
  // find loop top: first backward jcc
  let scan = CODE, loopTop = null;
  while (scan < CODE + BigInt(bin.length)) {
    const insn = (await import('../decode.mjs')).decode((i)=>Number(rmem.read(scan+BigInt(i),1n)), scan);
    if (insn.mnem === 'jcc') { loopTop = (scan + BigInt(insn.len) + insn.rel); break; }
    scan += BigInt(insn.len);
  }
  // run preamble up to loopTop
  while (cpu2.rip < loopTop) cpu2.step();
  const blk = compileLoop(rmem, loopTop);
  if (!blk) { console.log(`${name}: compiler declined (unsupported shape)`); continue; }
  const wmem = new WebAssembly.Memory({ initial: 1 });
  const view = new BigInt64Array(wmem.buffer);
  for (let r = 0; r < 16; r++) view[r] = BigInt.asIntN(64, cpu2.regs[r]);
  const { instance } = await WebAssembly.instantiate(blk.wasm, { js: { mem: wmem } });
  instance.exports.run();

  let ok = true;
  for (let r = 0; r < 16; r++) if (BigInt.asUintN(64, view[r]) !== ref[r]) {
    ok = false; console.log(`${name} reg ${r}: jit=${BigInt.asUintN(64,view[r]).toString(16)} ref=${ref[r].toString(16)}`);
  }
  if (ok) { pass++; console.log(`${name}: loop of ${blk.bodyInsns} ops, ${blk.live} regs in locals -> matches interpreter`); }
}
console.log(`\n${pass}/${loops.length} loops verified`);
