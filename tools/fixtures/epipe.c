/* SIGPIPE / EPIPE (docs/m3-engine.md).
 *
 * A write to a pipe whose read end is closed everywhere raises SIGPIPE; if
 * the process survives (handler, or SIG_IGN) the write fails with EPIPE.
 * 1. SIG_IGN: write -> -1/EPIPE, no signal seen.
 * 2. handler: write -> -1/EPIPE and the handler ran once.
 * 3. default: the read end is closed BEFORE forking (so no reader exists
 *    anywhere, in any scheduling order), the child writes and is killed by
 *    SIGPIPE; the parent reports the WIFSIGNALED status.
 *
 * Build:  gcc -O1 -o /tmp/breadth_epipe tools/fixtures/epipe.c
 */
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/wait.h>

static volatile int hits;
static void on_pipe(int s) { (void)s; hits++; }

int main(void) {
  int p[2];
  signal(SIGPIPE, SIG_IGN);
  if (pipe(p)) return 1;
  close(p[0]);
  errno = 0; ssize_t r = write(p[1], "x", 1);
  printf("ignored: r=%zd %s hits=%d\n", r, errno == EPIPE ? "EPIPE" : "other", hits);
  close(p[1]);

  signal(SIGPIPE, on_pipe);
  if (pipe(p)) return 1;
  close(p[0]);
  errno = 0; r = write(p[1], "x", 1);
  printf("handled: r=%zd %s hits=%d\n", r, errno == EPIPE ? "EPIPE" : "other", hits);
  close(p[1]);

  signal(SIGPIPE, SIG_DFL);
  if (pipe(p)) return 1;
  close(p[0]);                                     /* no reader anywhere, before the fork */
  pid_t c = fork();
  if (c == 0) { ssize_t w = write(p[1], "x", 1); (void)w; _exit(0); }   /* dies by SIGPIPE */
  close(p[1]);
  int st = 0; waitpid(c, &st, 0);
  printf("default: signaled=%d sig=%d\n", WIFSIGNALED(st), WIFSIGNALED(st) ? WTERMSIG(st) : 0);
  return 0;
}
