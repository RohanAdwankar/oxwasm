/* Freestanding whole-program AOT test: several functions, deep recursion,
 * a loop kernel, and raw syscalls (write/exit) — no libc. The translation
 * unit is everything reachable from _start; syscalls exercise the engine
 * escape. Built: clang -O2 -fno-vectorize -fcf-protection=none -nostdlib
 *                -static aot/unitprog.c -o /tmp/unitprog */
typedef unsigned long u64;
typedef unsigned char u8;

static long sys3(long n, long a, long b, long c) {
    long r;
    __asm__ volatile ("syscall" : "=a"(r)
                      : "a"(n), "D"(a), "S"(b), "d"(c)
                      : "rcx", "r11", "memory");
    return r;
}

__attribute__((noinline))
u64 fib(u64 n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }   /* recursion */

__attribute__((noinline))
u64 fnv(const u8 *p, u64 n) {                                     /* loop kernel */
    u64 h = 1469598103934665603ul;
    for (u64 i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ul; }
    return h;
}

__attribute__((noinline))
u64 mixdiv(u64 a, u64 b) {                                        /* div path */
    return (a / b) + (a % b) * 3;
}

static u8 buf[4096];

__attribute__((noinline))
void render(u64 v, char *out) {                                   /* hex print */
    for (int i = 15; i >= 0; i--) { out[15 - i] = "0123456789abcdef"[(v >> (i * 4)) & 15]; }
    out[16] = '\n'; out[17] = 0;
}

void _start(void) {
    for (u64 i = 0; i < sizeof buf; i++) buf[i] = (u8)(i * 167 + 13);
    u64 h = fnv(buf, sizeof buf);
    u64 f = fib(25);
    u64 d = mixdiv(h, f + 1);
    char line[18];
    render(h ^ d, line);
    sys3(1, 1, (long)line, 17);          /* write(1, line, 17) */
    sys3(60, (long)(f & 0x7f), 0, 0);    /* exit(fib&0x7f) */
    __builtin_unreachable();
}
