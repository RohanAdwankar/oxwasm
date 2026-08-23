// End-to-end: a whole program through the tiering engine. Correctness vs the
// pure interpreter, and proof the JIT tiers actually fired.
import { CPU, Memory } from '../interp.mjs';
import { Engine } from '../engine.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

const CODE = 0x10000000n, GBASE = 0x20000000n, NPX = 4096;
// Two hot loops back to back: a pixel transform (SIMD-eligible), then an
// integer reduction (superblock-eligible). Cold preamble is interpreted.
const asm = `
; --- pixel transform: dst[i] = (src[i]+0x10)^0x55 ---
mov rsi, 0x20000000
mov rdi, 0x20008000
mov rcx, ${NPX}
pix:
movzx eax, byte [rsi]
add rax, 0x10
xor rax, 0x55
and rax, 0xff
mov [rdi], al
inc rsi
inc rdi
dec rcx
jnz pix
; --- integer checksum over the output ---
mov rsi, 0x20008000
mov rcx, ${NPX}
mov rbx, 0
sum:
movzx eax, byte [rsi]
add rbx, rax
inc rsi
dec rcx
jnz sum
hlt
`;
writeFileSync('/tmp/eng.asm', 'BITS 64\n' + asm);
execFileSync('nasm', ['-f','bin','-o','/tmp/eng.bin','/tmp/eng.asm']);
const bin = readFileSync('/tmp/eng.bin'); const code = new Uint8Array(0x10000); code.set(bin);
const mkSrc = () => { const g = new Uint8Array(0x10000); for (let i=0;i<NPX;i++) g[i]=(i*13+7)&0xff; return g; };

// reference: pure interpreter
const gRef = mkSrc();
const cpu = new CPU(new Memory([{ base: CODE, bytes: code }, { base: GBASE, bytes: gRef }]));
cpu.rip = CODE; for (let r=0;r<16;r++) cpu.regs[r]=0n;
while (cpu.rip >= CODE && cpu.rip < CODE + BigInt(bin.length)) cpu.step();
const refDst = gRef.slice(0x8000, 0x8000 + NPX);
const refSum = cpu.regs[3];   // rbx

// tiering engine
const eng = new Engine(code, { entry: CODE, guestBase: GBASE, ramBytes: 0x10000, threshold: 8 });
eng.ramView.set(mkSrc().subarray(0, 0x10000));
for (let r=0;r<16;r++) eng.cpu.regs[r]=0n;
const stats = eng.run();
const engDst = eng.ramView.slice(0x8000, 0x8000 + NPX);
const engSum = eng.cpu.regs[3];

let dstOk = true; for (let i=0;i<NPX;i++) if (engDst[i]!==refDst[i]) { dstOk=false; console.log(`dst ${i}: ${engDst[i]} vs ${refDst[i]}`); break; }
console.log(`pixel output: ${dstOk ? 'byte-exact vs interpreter' : 'MISMATCH'}`);
console.log(`checksum: engine=${engSum} interpreter=${refSum}  ${engSum===refSum?'MATCH':'MISMATCH'}`);
console.log(`\ntiers compiled: ${JSON.stringify(stats.tiers)}`);
console.log(`instructions interpreted: ${stats.interpreted}  (vs ${NPX*8 + NPX*4}+ if fully interpreted)`);
console.log(`compiled-loop runs: ${stats.compiledRuns}`);
const bothFired = stats.tiers.simd >= 1 && stats.tiers.superblock >= 1;
console.log(`\n${dstOk && engSum===refSum && bothFired ? 'PASS' : 'CHECK'}: correct end-to-end, both SIMD and superblock tiers fired`);
