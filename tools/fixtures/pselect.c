// pselect6/ppoll with a temporary signal mask: SIGCHLD is blocked, a child
// exits while the parent waits with a mask that admits it, the wait must
// return EINTR and the handler must have run (make -j2's wait loop).
#include <stdio.h>
#include <signal.h>
#include <unistd.h>
#include <errno.h>
#include <poll.h>
#include <sys/select.h>
#include <sys/wait.h>
static volatile int got;
static void h(int s) { got = s; }
int main(void) {
  sigset_t blk, old, wait_mask;
  sigemptyset(&blk); sigaddset(&blk, SIGCHLD); sigprocmask(SIG_BLOCK, &blk, &old);
  struct sigaction sa = { .sa_handler = h }; sigaction(SIGCHLD, &sa, 0);
  sigemptyset(&wait_mask);                                   // admits everything during the wait
  int p[2]; pipe(p);
  pid_t c = fork(); if (c == 0) { usleep(20000); _exit(7); }
  fd_set r; FD_ZERO(&r); FD_SET(p[0], &r);
  int n = pselect(p[0] + 1, &r, 0, 0, 0, &wait_mask);
  int e = errno; sigset_t cur; sigprocmask(SIG_SETMASK, 0, &cur);
  int st; waitpid(c, &st, 0);
  printf("pselect %d errno %d(EINTR=%d) got %d chld-still-blocked %d child %d\n", n, e, EINTR, got, sigismember(&cur, SIGCHLD), WEXITSTATUS(st));
  got = 0; c = fork(); if (c == 0) { usleep(20000); _exit(3); }
  struct pollfd pf = { p[0], POLLIN, 0 };
  n = ppoll(&pf, 1, 0, &wait_mask); e = errno; sigprocmask(SIG_SETMASK, 0, &cur); waitpid(c, &st, 0);
  printf("ppoll %d errno %d got %d chld-still-blocked %d child %d\n", n, e, got, sigismember(&cur, SIGCHLD), WEXITSTATUS(st));
  struct timespec ts = { 0, 30000000 }; got = 0;
  n = ppoll(&pf, 1, &ts, &wait_mask); sigprocmask(SIG_SETMASK, 0, &cur);
  printf("ppoll timeout %d got %d chld-still-blocked %d\n", n, got, sigismember(&cur, SIGCHLD));
  write(p[1], "x", 1); n = pselect(p[0] + 1, &r, 0, 0, 0, &wait_mask); sigprocmask(SIG_SETMASK, 0, &cur);
  printf("pselect ready %d chld-still-blocked %d\n", n, sigismember(&cur, SIGCHLD));
  return 0;
}
