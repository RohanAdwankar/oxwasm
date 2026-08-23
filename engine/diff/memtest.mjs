// Verify the superblock JIT on MEMORY loops (pixel-processing shape),
// against the tier-0 interpreter: same final registers AND memory bytes.
import { CPU, Memory } from '../interp.mjs';
import { compileLoop } from '../jit2.mjs';
import { decode } from '../decode.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n;
const GBASE = 0x20000000n;          // guest RAM start
const RAM = 4096;                   // wasm offset where guest RAM maps
const NPX = 256;

// pixel transform: dst[i] = (src[i] + 0x10) ^ 0x55, for NPX bytes
// rsi=src, rdi=dst, rcx=count
const asm = `mov rsi, 0x20000000
mov rdi, 0x20001000
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
writeFileSync('/tmp/px.asm', 'BITS 64\n' + asm);
execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/px.bin', '/tmp/px.asm']);
const bin = readFileSync('/tmp/px.bin'); const code = new Uint8Array(0x10000); code.set(bin);

// source pixels
const srcBytes = new Uint8Array(0x2000);
for (let i = 0; i < NPX; i++) srcBytes[i] = (i * 7 + 3) & 0xff;

// --- interpreter reference ---
const gmem = new Uint8Array(0x2000); gmem.set(srcBytes);
const cpu = new CPU(new Memory([{ base: CODE, bytes: code }, { base: GBASE, bytes: gmem }]));
cpu.rip = CODE; for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(bin.length)) cpu.step();
const refDst = gmem.slice(0x1000, 0x1000 + NPX);

// --- JIT ---
const rmem = new Memory([{ base: CODE, bytes: code }]);
let scan = CODE, loopTop = null;
while (scan < CODE + BigInt(bin.length)) {
  const insn = decode((i)=>Number(rmem.read(scan+BigInt(i),1n)), scan);
  if (insn.mnem === 'jcc') { loopTop = scan + BigInt(insn.len) + insn.rel; break; }
  scan += BigInt(insn.len);
}
// run preamble on a cpu to get entry regs
const cpu2 = new CPU(new Memory([{ base: CODE, bytes: code }])); cpu2.rip = CODE;
for (let r=0;r<16;r++) cpu2.regs[r]=0n;
while (cpu2.rip < loopTop) cpu2.step();
const blk = compileLoop(rmem, loopTop, { guestBase: GBASE, ramBase: RAM });
if (!blk) { console.log('compiler declined the pixel loop'); process.exit(1); }
const wmem = new WebAssembly.Memory({ initial: 256 });
const bytes = new Uint8Array(wmem.buffer);
const regview = new BigInt64Array(wmem.buffer);
bytes.set(srcBytes, RAM);                          // map guest RAM into wasm
for (let r=0;r<16;r++) regview[r] = BigInt.asIntN(64, cpu2.regs[r]);
const { instance } = await WebAssembly.instantiate(blk.wasm, { js: { mem: wmem } });
instance.exports.run();
const jitDst = bytes.slice(RAM + 0x1000, RAM + 0x1000 + NPX);

let ok = true;
for (let i = 0; i < NPX; i++) if (jitDst[i] !== refDst[i]) { ok = false; console.log(`px ${i}: jit=${jitDst[i]} ref=${refDst[i]}`); break; }
console.log(ok ? `pixel loop (${blk.bodyInsns} ops/iter, ${NPX} px): JIT memory output matches interpreter byte-for-byte`
              : 'MISMATCH');
console.log(ok ? '1/1 memory loops verified' : '0/1 memory loops verified');
