// madvise(MADV_DONTNEED) on private anonymous memory reads back as zeros;
// mlock/munlock succeed. jemalloc's startup probe is the first shape.
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
int main(void) {
  size_t n = 1 << 20;
  unsigned char *p = mmap(0, n, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  if (p == MAP_FAILED) return 1;
  memset(p, 0xa5, n);
  long s = 0; for (size_t i = 0; i < n; i += 4096) s += p[i];
  printf("before %ld\n", s);
  int r = madvise(p + 4096, n - 8192, MADV_DONTNEED);       // inner pages only
  s = 0; for (size_t i = 0; i < n; i += 4096) s += p[i];
  printf("madvise %d after %ld first %d last %d\n", r, s, p[0], p[n - 1]);
  printf("mlock %d munlock %d\n", mlock(p, 4096), munlock(p, 4096));
  static unsigned char heap[1 << 16];                       // static bss, page aligned enough to test the mid-page rounding
  memset(heap, 1, sizeof heap);
  r = madvise((void *)(((unsigned long)heap + 4095) & ~4095UL), 4096, MADV_DONTNEED);
  s = 0; for (size_t i = 0; i < sizeof heap; i++) s += heap[i];
  printf("bss %d sum %ld\n", r, s);
  return 0;
}
