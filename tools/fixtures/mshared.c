/* Shared file mappings + mremap (docs/m3-engine.md).
 *
 * 1. mmap a file MAP_SHARED|PROT_WRITE, store through the mapping, msync,
 *    read the file back through a fresh descriptor: the bytes must be there.
 * 2. Store again, munmap (no msync): must also reach the file.
 * 3. A store past EOF inside the last page must NOT grow the file.
 * 4. mremap(MREMAP_MAYMOVE) an anonymous region to a larger size: the old
 *    contents survive the move, the tail is zero.
 * 5. Leave a mapping dirty at exit: the file is checked by the harness
 *    (outFile) after the process is gone.
 * Every line printed is a function of the program, so it byte-compares.
 *
 * Build:  gcc -O1 -o /tmp/breadth_mshared tools/fixtures/mshared.c
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>

static const char *PATH = "/tmp/breadth_mshared.dat";

static void show(const char *tag) {
  int fd = open(PATH, O_RDONLY); char buf[64] = {0}; int n = read(fd, buf, 63); close(fd);
  struct stat st; stat(PATH, &st);
  printf("%s: n=%d size=%ld data=%s\n", tag, n, (long)st.st_size, buf);
}

int main(void) {
  int fd = open(PATH, O_RDWR | O_CREAT | O_TRUNC, 0644);
  const char *init = "0123456789abcdef";
  if (write(fd, init, 16) != 16) return 1;
  char *m = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (m == MAP_FAILED) { printf("mmap failed\n"); return 1; }
  memcpy(m, "AAAA", 4);
  msync(m, 4096, MS_SYNC);
  show("after msync");                              /* AAAA456789abcdef, size 16 */
  memcpy(m + 4, "BBBB", 4);
  m[20] = 'Z';                                      /* past EOF in the page: no growth */
  munmap(m, 4096);
  show("after munmap");                             /* AAAABBBB89abcdef, size 16 */

  /* mremap: anonymous region grows and moves; contents preserved */
  char *a = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
  memset(a, 'q', 4096);
  char *b = mremap(a, 4096, 3 * 4096, MREMAP_MAYMOVE);
  if (b == MAP_FAILED) { printf("mremap failed\n"); return 1; }
  int ok = b[0] == 'q' && b[4095] == 'q' && b[4096] == 0 && b[3 * 4096 - 1] == 0;
  printf("mremap: ok=%d\n", ok);
  munmap(b, 3 * 4096);

  /* dirty at exit: the harness compares the file after the process ends */
  char *m2 = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  memcpy(m2 + 8, "CCCC", 4);
  close(fd);
  printf("exit with dirty mapping\n");
  return 0;
}
