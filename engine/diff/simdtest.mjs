import { CPU, Memory } from '../interp.mjs';
import { compileVectorLoop } from '../jitsimd.mjs';
import { decode } from '../decode.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n, GBASE = 0x20000000n, RAM = 1 << 20;
for (const NPX of [1000, 4096, 255, 16, 7]) {   // include non-multiples of 16 and tiny
  const asm = `mov rsi, 0x20000000
mov rdi, 0x20800000
mov rcx, ${NPX}
top:
movzx eax, byte [rsi]
add rax, 0x10
xor rax, 0x55
and rax, 0xff
mov [rdi], al
inc rsi
inc rdi
dec rcx
jnz top`;
  writeFileSync('/tmp/sx.asm', 'BITS 64\n' + asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/sx.bin', '/tmp/sx.asm']);
  const bin = readFileSync('/tmp/sx.bin'); const code = new Uint8Array(0x10000); code.set(bin);
  const src = new Uint8Array(0x1000000); for (let i = 0; i < NPX; i++) src[i] = (i * 13 + 7) & 0xff;

  // interpreter reference
  const g = src.slice(); const cpu = new CPU(new Memory([{ base: CODE, bytes: code }, { base: GBASE, bytes: g }]));
  cpu.rip = CODE; for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
  while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(bin.length)) cpu.step();
  const ref = g.slice(0x800000, 0x800000 + NPX);

  // SIMD JIT
  const rmem = new Memory([{ base: CODE, bytes: code }]);
  let scan = CODE, top = null;
  while (scan < CODE + BigInt(bin.length)) { const insn = decode(i=>Number(rmem.read(scan+BigInt(i),1n)),scan);
    if (insn.mnem==='jcc'){top=scan+BigInt(insn.len)+insn.rel;break;} scan+=BigInt(insn.len); }
  const cpu2 = new CPU(new Memory([{ base: CODE, bytes: code }])); cpu2.rip = CODE;
  for (let r=0;r<16;r++) cpu2.regs[r]=0n; while (cpu2.rip < top) cpu2.step();
  const blk = compileVectorLoop(rmem, top, { guestBase: GBASE, ramBase: RAM });
  if (!blk) { console.log(`NPX=${NPX}: vectorizer declined`); continue; }
  const wmem = new WebAssembly.Memory({ initial: 512 });
  const bytes = new Uint8Array(wmem.buffer); const rv = new BigInt64Array(wmem.buffer);
  bytes.set(src, RAM); for (let r=0;r<16;r++) rv[r] = BigInt.asIntN(64, cpu2.regs[r]);
  const { instance } = await WebAssembly.instantiate(blk.wasm, { js: { mem: wmem } });
  instance.exports.run();
  const jit = bytes.slice(RAM + 0x800000, RAM + 0x800000 + NPX);
  let ok = true; for (let i = 0; i < NPX; i++) if (jit[i] !== ref[i]) { ok = false; console.log(`NPX=${NPX} px${i}: jit=${jit[i]} ref=${ref[i]}`); break; }
  console.log(`NPX=${NPX}: ${ok ? 'SIMD output byte-exact vs interpreter' : 'MISMATCH'} (${blk.vectorOps} vec ops, 16 lanes)`);
}
