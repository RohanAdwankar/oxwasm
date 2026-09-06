// repscan.c - rep-prefixed string ops the JVM's subtype check relies on
// (repne scasq over a klass's secondary supers), plus repe cmpsb and the
// rcx=0 corner where hardware leaves the flags untouched. Prints rcx, the
// rdi/rsi advance and ZF/CF after each form; native and engine must agree.
#include <stdio.h>
#include <stdint.h>
static void scasq(uint64_t *arr, uint64_t n, uint64_t key, int zf_before) {
  uint64_t rcx = n, rdi = (uint64_t)arr, flags;
  __asm__ volatile(
    "cmp $0, %[z]\n\t"            /* ZF := (zf_before == 0) so the rcx=0 case shows flags untouched */
    "repne scasq\n\t"
    "pushfq\n\tpop %[f]"
    : [f] "=r" (flags), "+c" (rcx), "+D" (rdi) : "a" (key), [z] "r" ((uint64_t)zf_before) : "cc", "memory");
  printf("scasq n=%llu key=%llu -> rcx=%llu adv=%llu ZF=%d CF=%d\n", (unsigned long long)n, (unsigned long long)key,
         (unsigned long long)rcx, (unsigned long long)((rdi - (uint64_t)arr) / 8), (int)((flags >> 6) & 1), (int)(flags & 1));
}
static void cmpsb(const char *a, const char *b, uint64_t n) {
  uint64_t rcx = n, rsi = (uint64_t)a, rdi = (uint64_t)b, flags;
  __asm__ volatile("repe cmpsb\n\tpushfq\n\tpop %[f]" : [f] "=r" (flags), "+c" (rcx), "+S" (rsi), "+D" (rdi) : : "cc", "memory");
  printf("cmpsb n=%llu -> rcx=%llu adv=%llu ZF=%d CF=%d\n", (unsigned long long)n, (unsigned long long)rcx,
         (unsigned long long)(rsi - (uint64_t)a), (int)((flags >> 6) & 1), (int)(flags & 1));
}
static void scasb(const char *s, uint64_t n, char key) {
  uint64_t rcx = n, rdi = (uint64_t)s, flags;
  __asm__ volatile("repne scasb\n\tpushfq\n\tpop %[f]" : [f] "=r" (flags), "+c" (rcx), "+D" (rdi) : "a" ((uint64_t)(unsigned char)key) : "cc", "memory");
  printf("scasb n=%llu key=%d -> rcx=%llu adv=%llu ZF=%d\n", (unsigned long long)n, key, (unsigned long long)rcx,
         (unsigned long long)(rdi - (uint64_t)s), (int)((flags >> 6) & 1));
}
int main(void) {
  uint64_t arr[6] = { 11, 22, 33, 44, 55, 66 };
  for (int i = 0; i < 200; i++) {            /* hot enough to tier up */
    scasq(arr, 6, 11, 0); scasq(arr, 6, 66, 0); scasq(arr, 6, 99, 0); scasq(arr, 3, 44, 0);
    scasq(arr, 0, 11, 0); scasq(arr, 0, 11, 1); scasq(arr, 1, 11, 0); scasq(arr, 1, 12, 0);
    cmpsb("abcdef", "abcdef", 6); cmpsb("abcdef", "abcxef", 6); cmpsb("abc", "abd", 2); cmpsb("a", "b", 0);
    scasb("hello world", 11, ' '); scasb("hello", 5, 'z'); scasb("hello", 0, 'h');
    if (i == 0 || i == 199) puts("---");
  }
  return 0;
}
