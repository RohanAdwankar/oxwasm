// Green threads: clone(CLONE_VM) + futex wait/wake + thread exit, raw
// syscalls with no libc. The parent futex-waits on a flag; the child (own
// mmap'd stack) sets it, wakes, and exits with syscall 60 (thread exit —
// must NOT kill the process). Exit code 42 proves the whole dance: child
// ran, wake delivered, parent resumed, exit_group carried the value.
// glib refuses to start (fatal g_error) without exactly this machinery.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const asm = `BITS 64
global _start
section .text
_start:
    mov eax, 9                  ; mmap(0, 64K, RW, PRIVATE|ANON, -1, 0)
    xor edi, edi
    mov esi, 65536
    mov edx, 3
    mov r10d, 0x22
    mov r8, -1
    xor r9d, r9d
    syscall
    lea rsi, [rax + 65536]      ; child stack top
    mov edi, 0x11F00            ; CLONE_VM|FS|FILES|SIGHAND|THREAD
    mov eax, 56
    syscall
    test rax, rax
    jz child
parent_wait:
    mov eax, [rel flag]
    cmp eax, 42
    je done
    lea rdi, [rel flag]         ; futex(&flag, WAIT, seen, NULL)
    xor esi, esi
    mov edx, eax
    xor r10d, r10d
    mov eax, 202
    syscall
    jmp parent_wait
done:
    mov edi, 42
    mov eax, 231                ; exit_group(42)
    syscall
child:
    mov rbx, 20000              ; do some work first so the parent really blocks
.spin:
    dec rbx
    jnz .spin
    mov dword [rel flag], 42
    lea rdi, [rel flag]
    mov esi, 1                  ; futex(&flag, WAKE, all)
    mov edx, 0x7fffffff
    mov eax, 202
    syscall
    xor edi, edi
    mov eax, 60                 ; THREAD exit — process must survive
    syscall
section .data
flag: dd 0
`;
writeFileSync('/tmp/tt.asm', asm);
execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/tt.o', '/tmp/tt.asm']);
execFileSync('ld', ['-static', '-o', '/tmp/tt.elf', '/tmp/tt.o']);
const elf = new Uint8Array(readFileSync('/tmp/tt.elf'));

const eng = new LinuxEngine(elf, { argv: ['tt'] });
const r = eng.run();
const ok = r.exitCode === 42;
console.log(`clone+futex+thread-exit: exit=${r.exitCode} (want 42) threads=${eng.threads.length}${ok ? '' : '  MISMATCH'}`);
if (!ok) process.exit(1);
