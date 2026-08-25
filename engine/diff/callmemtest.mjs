// Differential test: `call r/m64` with an rsp-relative MEMORY operand must
// fetch the target from the slot at the OLD rsp — x86 reads the operand
// before pushing the return address. pixman's composite dispatch does
// `call *0x48(%rsp)`; a push-first reader lands one slot low and calls the
// neighboring value (there: the implementation struct pointer → heap fault).
// The wrong-slot value here is a real function returning a different value,
// so a regression is a clean exit-code mismatch, not a crash.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

let asmN = 0;
const assembleWat = (wat) => {
  const w = `/tmp/cm_${process.pid}_${asmN++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', [w + '.wat', '-o', w + '.wasm']);
  return new Uint8Array(readFileSync(w + '.wasm'));
};

const asm = `BITS 64
global _start
section .text
_start:
    xor ebx, ebx
    mov ecx, 100
.loop:
    call work
    dec ecx
    jnz .loop
    mov rdi, rbx            ; 100 iff every call took the right slot
    mov eax, 60
    syscall
work:
    sub rsp, 0x40
    lea rax, [rel good]
    mov [rsp+0x18], rax
    lea rax, [rel poison]
    mov [rsp+0x10], rax     ; slot a push-first reader would fetch
    mov [rsp+0x20], rax     ; slot a pop-style +8 error would fetch
    call qword [rsp+0x18]
    add rsp, 0x40
    add rbx, rax
    ret
good:
    mov eax, 1
    ret
poison:
    mov eax, 101
    ret
`;
writeFileSync('/tmp/cm.asm', asm);
execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/cm.o', '/tmp/cm.asm']);
execFileSync('ld', ['-static', '-o', '/tmp/cm.elf', '/tmp/cm.o']);
const elf = new Uint8Array(readFileSync('/tmp/cm.elf'));

let fail = 0;
for (const [name, opts] of [['interp', {}], ['aot', { assembleWat, aotLoopThreshold: 8 }]]) {
  const eng = new LinuxEngine(elf, { argv: ['cm'], ...opts });
  const r = eng.run();
  const aot = r.stats.tiers?.aot || 0;
  const ok = r.exitCode === 100 && (name === 'interp' || aot >= 1);
  if (!ok) fail++;
  console.log(`${name}: exit=${r.exitCode} (want 100) aot-units=${aot}${ok ? '' : '  MISMATCH'}`);
}
console.log(fail ? 'call-mem (rsp-relative indirect call) FAILED' : 'call-mem (rsp-relative indirect call) reads the pre-push slot in both tiers');
if (fail) process.exit(1);
