/* Big-heap fixture (docs/m3-engine.md): a heap that outgrows the brk gap.
 *
 * Allocates 160MB in 64KB pieces, fills each with a pattern, then verifies
 * every byte and prints a checksum. glibc's malloc serves the main arena
 * from brk until brk stops growing, then from mmap; the engine's break must
 * refuse to grow into the mmap arena above it (where ld.so's own early pages
 * live) rather than hand the heap memory that is already someone else's.
 * vim on a 14MB file corrupted ld.so's link_map chain this way and faulted
 * in _dl_fini at exit.
 *
 * Build:  gcc -O1 -o /tmp/breadth_bigheap tools/fixtures/bigheap.c
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define PIECE 65536
#define N 2560               /* 160MB */

int main(void) {
  unsigned char *p[N];
  for (int i = 0; i < N; i++) {
    p[i] = malloc(PIECE);
    if (!p[i]) { printf("oom at %d\n", i); return 1; }
    memset(p[i], (i * 7 + 3) & 0xff, PIECE);
  }
  unsigned long sum = 0; int bad = 0;
  for (int i = 0; i < N; i++) {
    unsigned char want = (i * 7 + 3) & 0xff;
    for (int j = 0; j < PIECE; j += 4096) if (p[i][j] != want || p[i][j + 4095] != want) bad++;
    sum += p[i][17] + (unsigned long)i * p[i][PIECE - 1];
  }
  for (int i = 0; i < N; i++) free(p[i]);
  printf("pieces=%d bad=%d sum=%lu\n", N, bad, sum);
  return bad ? 2 : 0;
}
