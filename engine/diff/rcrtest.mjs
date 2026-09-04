// Differential test: rcl/rcr (rotate through carry) for every operand size,
// counts 0..66 and both incoming CF states, against the hardware. CF is
// checked at every count, OF only at count 1 (undefined otherwise). The guest
// folds every result and its CF/OF into one 64-bit hash and writes it to
// stdout; native and both engine tiers must agree byte for byte.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
let asmN = 0;
const assembleWat = (wat) => {
  const w = `/tmp/rc_${process.pid}_${asmN++}`; writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  return new Uint8Array(readFileSync(w + '.wasm'));
};
const body = (mn, reg, sz) => `
    mov ecx, 0
.c_${mn}_${sz}:
    mov rbx, r12
    clc
    ${mn} ${reg}, cl
    setc al
    seto dl
    movzx eax, al
    movzx edx, dl
    shl edx, 11
    cmp ecx, 1
    jne .n1_${mn}_${sz}
    or eax, edx
.n1_${mn}_${sz}:
    xor r13, rbx
    mov rdx, 0x100000001b3
    imul r13, rdx
    xor r13, rax
    mov rbx, r12
    stc
    ${mn} ${reg}, cl
    setc al
    seto dl
    movzx eax, al
    movzx edx, dl
    shl edx, 11
    cmp ecx, 1
    jne .n2_${mn}_${sz}
    or eax, edx
.n2_${mn}_${sz}:
    xor r13, rbx
    mov rdx, 0x100000001b3
    imul r13, rdx
    xor r13, rax
    inc ecx
    cmp ecx, 67
    jne .c_${mn}_${sz}
`;
const asm = `BITS 64
global _start
section .text
_start:
    mov r13, 0xcbf29ce484222325
    mov r14, 0x9e3779b97f4a7c15
    mov r15, 0
.v:
    mov r12, r14
    mov rdx, 6364136223846793005
    imul r14, rdx
    mov rdx, 1442695040888963407
    add r14, rdx
${body('rcl', 'bl', 1)}${body('rcr', 'bl', 1)}${body('rcl', 'bx', 2)}${body('rcr', 'bx', 2)}
${body('rcl', 'ebx', 4)}${body('rcr', 'ebx', 4)}${body('rcl', 'rbx', 8)}${body('rcr', 'rbx', 8)}
    ; rcl/rcr by 1 (D1 form) and by immediate (C1 form)
    mov rbx, r12
    stc
    rcr rbx, 1
    xor r13, rbx
    mov rbx, r12
    clc
    rcl ebx, 1
    xor r13, rbx
    mov rbx, r12
    stc
    rcr bx, 5
    xor r13, rbx
    mov rbx, r12
    stc
    rcl bl, 9
    xor r13, rbx
    inc r15
    cmp r15, 24
    jne .v
    mov [buf], r13
    mov eax, 1
    mov edi, 1
    lea rsi, [buf]
    mov edx, 8
    syscall
    mov eax, 60
    xor edi, edi
    syscall
section .bss
buf: resb 8
`;
writeFileSync('/tmp/rc.asm', asm);
execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/rc.o', '/tmp/rc.asm']);
execFileSync('ld', ['-static', '-o', '/tmp/rc.elf', '/tmp/rc.o']);
const elf = new Uint8Array(readFileSync('/tmp/rc.elf'));
const native = execFileSync('/tmp/rc.elf');
const hex = (b) => Buffer.from(b).toString('hex');
let fail = 0;
for (const [name, opts] of [['interp', {}], ['aot', { assembleWat, aotLoopThreshold: 8 }]]) {
  const eng = new LinuxEngine(elf, { argv: ['rc'], ...opts });
  const r = eng.run();
  const out = Buffer.concat(eng.stdoutBytes ? eng.stdoutBytes.map(b => Buffer.from(b)) : [Buffer.from(eng.stdout.join(''), 'latin1')]);
  const ok = r.exitCode === 0 && hex(out) === hex(native);
  if (!ok) fail++;
  console.log(`${name}: exit=${r.exitCode} hash=${hex(out)} native=${hex(native)}${ok ? '' : '  MISMATCH'}`);
}
console.log(fail ? 'rcl/rcr FAILED' : 'rcl/rcr: 8 sizes x 67 counts x 2 carry states bit-exact vs hardware in both tiers');
if (fail) process.exit(1);
