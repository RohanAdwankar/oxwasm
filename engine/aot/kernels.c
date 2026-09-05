#include <stdint.h>
// FNV-1a 64-bit: tests 64-bit multiply, xor, byte-stride loop
__attribute__((noinline))
uint64_t fnv1a(const unsigned char *p, uint64_t n) {
    uint64_t h = 1469598103934665603ULL;
    for (uint64_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}
// sum of a*x+y over arrays: tests signed 32-bit multiply/add, i32.load stride-4
__attribute__((noinline))
int64_t saxpy_sum(const int32_t *x, const int32_t *y, uint64_t n, int32_t a) {
    int64_t s = 0;
    for (uint64_t i = 0; i < n; i++) s += (int64_t)(a * x[i] + y[i]);
    return s;
}
// Collatz total steps for 1..n: tests branches, signed div-by-2 (shift), odd path mul
__attribute__((noinline))
uint64_t collatz_total(uint64_t n) {
    uint64_t total = 0;
    for (uint64_t k = 1; k <= n; k++) {
        uint64_t x = k, steps = 0;
        while (x != 1) { if (x & 1) x = 3*x + 1; else x >>= 1; steps++; }
        total += steps;
    }
    return total;
}
