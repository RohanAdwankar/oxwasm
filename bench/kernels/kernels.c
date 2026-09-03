// Instruction-class microbenchmarks. The aggregate "5-10x off native" says
// nothing about WHERE the tax is, so each kernel leans on one thing and is
// timed the same way natively and on the engine. The ratios decompose the
// gap: a translator rewrite is worth doing only for the classes that are
// actually expensive, and the earlier op histogram could not tell them apart.
//
// Each kernel returns a checksum so nothing can be optimised away, and each
// runs the same iteration count in both worlds.
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

// 1. integer ALU + flags: add/sub/cmp/jcc, the case lazy flags exist for
static uint64_t k_alu(uint64_t n) {
  uint64_t a = 1, b = 2, s = 0;
  for (uint64_t i = 0; i < n; i++) {
    a += i; b -= a; if (b > a) s += 3; else s -= 1;
    a ^= b; b += a >> 3;
  }
  return s + a + b;
}

// 2. memory streaming: address computation and loads/stores
static uint64_t k_mem(uint64_t n, uint64_t *buf, uint64_t len) {
  uint64_t s = 0;
  for (uint64_t i = 0; i < n; i++) { uint64_t j = i & (len - 1); buf[j] += i; s ^= buf[j]; }
  return s;
}

// 3. call/ret: the funcref-table path, not straight-line code.
// noinline is load-bearing — at -O2 gcc inlined this and the kernel measured
// a multiply chain with no calls in it, which read as 0.9x and looked like
// call/ret being faster than native.
__attribute__((noinline)) static uint64_t leaf(uint64_t x) { return x * 2654435761u + 1; }

// call1/call8/call64: the SAME call structure with callees of increasing
// size. Two hypotheses about the call tax died on the assumption that its
// cost was proportional to something per-call (the funcref lookup, then the
// register spill set); neither moved the number. This separates the two
// possible shapes directly. If the per-call cost is a FIXED frame charge,
// the ratio falls towards the straight-line ratio as the callee grows and
// the charge amortises. If it scales with the work around the call, it does
// not.
__attribute__((noinline)) static uint64_t leaf8(uint64_t x) {
  for (int i = 0; i < 8; i++) x = x * 2654435761u + 1;
  return x;
}
__attribute__((noinline)) static uint64_t leaf64(uint64_t x) {
  for (int i = 0; i < 64; i++) x = x * 2654435761u + 1;
  return x;
}
static uint64_t k_call8(uint64_t n) {
  uint64_t s = 0;
  for (uint64_t i = 0; i < n; i++) s += leaf8(i) ^ leaf8(s);
  return s;
}
static uint64_t k_call64(uint64_t n) {
  uint64_t s = 0;
  for (uint64_t i = 0; i < n; i++) s += leaf64(i) ^ leaf64(s);
  return s;
}
static uint64_t k_call(uint64_t n) {
  uint64_t s = 0;
  for (uint64_t i = 0; i < n; i++) s += leaf(i) ^ leaf(s);
  return s;
}

// 4. unpredictable branches: jcc that a predictor cannot help with
static uint64_t k_branch(uint64_t n) {
  uint64_t s = 0, x = 12345;
  for (uint64_t i = 0; i < n; i++) {
    x = x * 6364136223846793005ULL + 1442695040888963407ULL;
    if (x & 0x10000) s += 7; else if (x & 0x20000) s ^= 11; else s -= 3;
  }
  return s;
}

// 8. tokenizer-shaped scan: a byte load, a chain of class compares and
//    branches, a counter update, a pointer step - m4's next_token/peek_input
//    loop without the calls. The buffer is L1-resident text-like data.
static uint64_t k_scan(uint64_t n, const unsigned char *text, uint64_t mask) {
  uint64_t s = 0, digits = 0, words = 0, spaces = 0;
  for (uint64_t i = 0; i < n; i++) {
    unsigned char c = text[i & mask];              // one character per iteration, like a tokenizer
    if (c >= '0' && c <= '9') digits++;
    else if ((c | 0x20) >= 'a' && (c | 0x20) <= 'z') words++;
    else if (c == ' ' || c == '\n') spaces++;
    else s += c;
  }
  return s * 31 + digits + words * 3 + spaces * 7;
}

// 5. sub-width ops: the width masks x86 semantics force on every write
static uint64_t k_subw(uint64_t n) {
  uint32_t a = 1; uint16_t b = 2; uint8_t c = 3; uint64_t s = 0;
  for (uint64_t i = 0; i < n; i++) { a += (uint32_t)i; b ^= (uint16_t)a; c -= (uint8_t)b; s += c; }
  return s;
}

// 6. 64-bit multiply/divide: units the translator cannot fold away
static uint64_t k_muldiv(uint64_t n) {
  uint64_t s = 1, d = 3;
  for (uint64_t i = 1; i <= n; i++) { s = s * 31 + i; d = s / (i | 1); s ^= d; }
  return s;
}

int main(int argc, char **argv) {
  uint64_t n = argc > 2 ? strtoull(argv[2], 0, 10) : 3000000;
  static uint64_t buf[1024];
  const char *w = argc > 1 ? argv[1] : "alu";
  uint64_t r = 0;
  if (!strcmp(w, "alu"))         r = k_alu(n);
  else if (!strcmp(w, "mem"))    r = k_mem(n, buf, 1024);
  else if (!strcmp(w, "call"))   r = k_call(n);
  else if (!strcmp(w, "call8"))  r = k_call8(n);
  else if (!strcmp(w, "call64")) r = k_call64(n);
  else if (!strcmp(w, "branch")) r = k_branch(n);
  else if (!strcmp(w, "subw"))   r = k_subw(n);
  else if (!strcmp(w, "muldiv")) r = k_muldiv(n);
  else if (!strcmp(w, "scan")) {
    static unsigned char text[4096]; const char *pat = "define(`x', eval(12 * 3))dnl\nfoo bar 4711 baz  "; size_t pl = strlen(pat);
    for (int i = 0; i < 4096; i++) text[i] = pat[i % pl];
    r = k_scan(n, text, 4095); }
  else { printf("unknown kernel\n"); return 2; }
  printf("%s %llu\n", w, (unsigned long long)r);
  return 0;
}
