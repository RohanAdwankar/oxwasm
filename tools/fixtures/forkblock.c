/* Fork materialisation (docs/m3-engine.md): a fork child that BLOCKS before
 * exec/exit must not freeze its parent, and both must keep private memory.
 *
 * 1. The child writes 200KB into a pipe (more than the 64KB capacity, so it
 *    blocks until the parent drains); the parent reads it all, reaps the
 *    child and prints the byte count and exit status.
 * 2. The child sets a global to 7 BEFORE blocking on a read the parent has
 *    yet to satisfy (copy-on-write both ways: the parent must still see 1
 *    after the child ran; the child must see its own 7 after unblocking),
 *    then answers on a second pipe.
 * Every printed value is program-determined, so it byte-compares to native.
 *
 * Build:  gcc -O1 -o /tmp/breadth_forkblock tools/fixtures/forkblock.c
 */
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

static int g = 1;

int main(void) {
  /* 1. child fills a pipe past its capacity */
  int p[2]; if (pipe(p)) return 1;
  pid_t c = fork();
  if (c == 0) {
    close(p[0]);
    static char buf[4096]; memset(buf, 'x', sizeof buf);
    for (int i = 0; i < 50; i++) { ssize_t w = write(p[1], buf, sizeof buf); if (w != sizeof buf) _exit(2); }
    _exit(3);
  }
  close(p[1]);
  long total = 0; char rb[8192]; ssize_t n;
  while ((n = read(p[0], rb, sizeof rb)) > 0) total += n;
  close(p[0]);
  int st = 0; waitpid(c, &st, 0);
  printf("fill: bytes=%ld exited=%d status=%d\n", total, WIFEXITED(st), WEXITSTATUS(st));

  /* 2. child blocks reading before the parent writes; COW both ways */
  int a[2], b[2]; if (pipe(a) || pipe(b)) return 1;
  c = fork();
  if (c == 0) {
    close(a[1]); close(b[0]);
    g = 7;                                          /* before blocking: parent must not see it */
    char ch = 0; if (read(a[0], &ch, 1) != 1) _exit(4);   /* blocks: parent has not written yet */
    char reply[32]; int k = snprintf(reply, sizeof reply, "child g=%d got=%c", g, ch);
    if (write(b[1], reply, k) != k) _exit(5);
    _exit(6);
  }
  close(a[0]); close(b[1]);
  if (write(a[1], "Q", 1) != 1) return 1;
  char reply[32] = {0}; n = read(b[0], reply, sizeof reply - 1);
  waitpid(c, &st, 0);
  printf("pingpong: reply=\"%s\" parent g=%d status=%d\n", n > 0 ? reply : "(none)", g, WEXITSTATUS(st));
  return 0;
}
