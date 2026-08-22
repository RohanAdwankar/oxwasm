/* stepper — the differential oracle for oxwasm's M3 engine.
 *
 * Runs a flat binary of x86-64 code on the REAL CPU under ptrace,
 * single-stepping and printing architectural state after every
 * instruction. The tier-0 interpreter must match this line for line.
 *
 *   ./stepper code.bin maxsteps
 *
 * Fixed address-space contract (mirrored by the interpreter):
 *   code    at 0x10000000 (RWX)
 *   scratch at 0x20000000 (64 KiB, byte pattern (addr ^ addr>>8) & 0xff)
 *   stack   at 0x30000000 (64 KiB), rsp starts at 0x30008000
 * Initial registers: rN = 0x0101010101010100 + N (recognizable, nonzero).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <sys/ptrace.h>
#include <sys/user.h>
#include <sys/wait.h>
#include <sys/mman.h>

#define CODE_AT    0x10000000UL
#define SCRATCH_AT 0x20000000UL
#define STACK_AT   0x30000000UL
#define RSP_INIT   0x30008000UL

static void child(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror("code"); _exit(1); }
    void *code = mmap((void*)CODE_AT, 0x10000, PROT_READ|PROT_WRITE|PROT_EXEC,
                      MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED, -1, 0);
    unsigned char *scratch = mmap((void*)SCRATCH_AT, 0x10000, PROT_READ|PROT_WRITE,
                      MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED, -1, 0);
    void *stack = mmap((void*)STACK_AT, 0x10000, PROT_READ|PROT_WRITE,
                      MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED, -1, 0);
    if (code == MAP_FAILED || scratch == MAP_FAILED || stack == MAP_FAILED) _exit(2);
    fread(code, 1, 0x10000, f); fclose(f);
    for (unsigned long i = 0; i < 0x10000; i++)
        scratch[i] = (unsigned char)((SCRATCH_AT + i) ^ ((SCRATCH_AT + i) >> 8));
    ptrace(PTRACE_TRACEME, 0, 0, 0);
    raise(SIGSTOP);                      /* parent takes over from here */
    _exit(3);                            /* never reached */
}

static void print_regs(struct user_regs_struct *r) {
    printf("%llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx %llx\n",
        r->rip, r->rax, r->rbx, r->rcx, r->rdx, r->rsi, r->rdi, r->rbp, r->rsp,
        r->r8, r->r9, r->r10, r->r11, r->r12, r->r13, r->r14, r->r15, r->eflags);
}

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: stepper code.bin maxsteps\n"); return 1; }
    long max = atol(argv[2]);
    pid_t pid = fork();
    if (pid == 0) child(argv[1]);
    int st; waitpid(pid, &st, 0);        /* SIGSTOP from child */
    struct user_regs_struct r;
    ptrace(PTRACE_GETREGS, pid, 0, &r);
    r.rip = CODE_AT; r.rsp = RSP_INIT; r.rbp = RSP_INIT;
    r.rax = 0x0101010101010100UL + 0; r.rbx = 0x0101010101010100UL + 1;
    r.rcx = 0x0101010101010100UL + 2; r.rdx = 0x0101010101010100UL + 3;
    r.rsi = 0x0101010101010100UL + 4; r.rdi = 0x0101010101010100UL + 5;
    r.r8  = 0x0101010101010100UL + 8; r.r9  = 0x0101010101010100UL + 9;
    r.r10 = 0x0101010101010100UL + 10; r.r11 = 0x0101010101010100UL + 11;
    r.r12 = 0x0101010101010100UL + 12; r.r13 = 0x0101010101010100UL + 13;
    r.r14 = 0x0101010101010100UL + 14; r.r15 = 0x0101010101010100UL + 15;
    r.eflags = 0x202;
    ptrace(PTRACE_SETREGS, pid, 0, &r);
    print_regs(&r);
    for (long i = 0; i < max; i++) {
        if (ptrace(PTRACE_SINGLESTEP, pid, 0, 0) < 0) break;
        waitpid(pid, &st, 0);
        if (WIFEXITED(st) || WIFSIGNALED(st)) break;
        ptrace(PTRACE_GETREGS, pid, 0, &r);
        if (r.rip < CODE_AT || r.rip >= CODE_AT + 0x10000) break;
        print_regs(&r);
    }
    kill(pid, SIGKILL);
    return 0;
}
