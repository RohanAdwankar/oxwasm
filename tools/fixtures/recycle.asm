; recycle.asm - the page-recycle regression, as a self-contained static ELF.
; Tier code A at a fixed rwx page (hot inner loop, called repeatedly), munmap
; the page, map DIFFERENT code B at the same address, run it, and report what
; actually executed. An engine that keeps address-keyed translations across
; munmap prints A's answer from stale code; hardware (and a correct engine)
; prints B's.  Build: nasm -f bin -o recycle recycle.asm && chmod +x
BITS 64
org 0x400000
ehdr:
  db 0x7F, "ELF", 2, 1, 1, 0
  times 8 db 0
  dw 2                          ; ET_EXEC
  dw 0x3E                       ; EM_X86_64
  dd 1
  dq _start
  dq phdr - $$
  dq 0
  dd 0
  dw 64, 56, 1, 0, 0, 0
phdr:
  dd 1, 7                       ; PT_LOAD, RWX
  dq 0, $$, $$
  dq filesz, filesz, 0x1000

PAGE  equ 0x600000

_start:
  call map_page
  lea rsi, [codeA]
  mov rcx, codeA_len
  call copy_code
  mov rbx, 12                   ; call A repeatedly so the call profile tiers it
.callA:
  mov rax, PAGE
  call rax
  dec rbx
  jnz .callA                    ; rax now holds A's answer (111)
  mov r12, rax
  mov rax, 11                   ; munmap(PAGE, 0x1000)
  mov rdi, PAGE
  mov rsi, 0x1000
  syscall
  call map_page
  lea rsi, [codeB]
  mov rcx, codeB_len
  call copy_code
  mov rax, PAGE                 ; one call into the recycled page
  call rax
  cmp rax, 222
  jne .stale
  lea rsi, [msgB]               ; write(1, "B\n", 2)
  jmp .say
.stale:
  lea rsi, [msgA]
.say:
  mov rax, 1
  mov rdi, 1
  mov rdx, 2
  syscall
  mov rax, 60                   ; exit(last call's answer)
  mov rdi, 0
  syscall

map_page:                       ; mmap(PAGE, 0x1000, RWX, PRIVATE|ANON|FIXED, -1, 0)
  mov rax, 9
  mov rdi, PAGE
  mov rsi, 0x1000
  mov rdx, 7
  mov r10, 0x32
  mov r8, -1
  xor r9, r9
  syscall
  ret
copy_code:                      ; rsi -> PAGE, rcx bytes
  mov rdi, PAGE
  rep movsb
  ret

codeA:                          ; hot loop, answers 111
  mov rcx, 200000
.lp:
  dec rcx
  jnz .lp
  mov rax, 111
  ret
codeA_len equ $ - codeA

codeB:                          ; same shape, answers 222
  mov rcx, 200000
.lp:
  dec rcx
  jnz .lp
  mov rax, 222
  ret
codeB_len equ $ - codeB

msgA: db "A", 10
msgB: db "B", 10

filesz equ $ - $$
