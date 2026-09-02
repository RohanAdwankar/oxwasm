/* Signal fixture (docs/m3-engine.md): real signal delivery, deterministically.
 *
 * Covers, in order: a SA_SIGINFO handler entered by raise() (si_signo and
 * si_code checked, registers/flags intact across the handler); a signal
 * blocked with sigprocmask staying pending until unblocked; setitimer +
 * pause() returning EINTR after SIGALRM; nanosleep interrupted (no
 * SA_RESTART -> EINTR); SIGCHLD from a fork()ed child's _exit, reaped with
 * waitpid inside the handler; sigsuspend; SA_RESETHAND. Every printed value is
 * a function of the program, not of timing, so it byte-compares to native.
 *
 * Build:  gcc -O1 -o /tmp/breadth_signal tools/fixtures/signal.c
 */
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <sys/time.h>
#include <sys/wait.h>

static volatile int usr1_hits, usr1_code_ok, alrm_hits, chld_hits, chld_status, usr2_hits;

static void on_usr1(int sig, siginfo_t *si, void *uc) {
  (void)uc;
  usr1_hits++;
  usr1_code_ok = (si->si_signo == sig) && (si->si_code == SI_TKILL || si->si_code == SI_USER);
}
static void on_alrm(int sig) { (void)sig; alrm_hits++; }
static void on_chld(int sig) {
  (void)sig; int st = 0;
  if (waitpid(-1, &st, 0) > 0 && WIFEXITED(st)) { chld_hits++; chld_status = WEXITSTATUS(st); }
}
static void on_usr2(int sig) { (void)sig; usr2_hits++; }

int main(void) {
  /* 1. sigaction + raise, SA_SIGINFO; a live computation spans the handler */
  struct sigaction sa; memset(&sa, 0, sizeof sa);
  sa.sa_sigaction = on_usr1; sa.sa_flags = SA_SIGINFO; sigemptyset(&sa.sa_mask);
  sigaction(SIGUSR1, &sa, 0);
  volatile long acc = 0;
  for (int i = 0; i < 1000; i++) { acc += i * 3; if (i == 500) raise(SIGUSR1); }
  printf("usr1 hits=%d siginfo_ok=%d acc=%ld\n", usr1_hits, usr1_code_ok, acc);

  /* 2. blocked signal stays pending until unblocked */
  sigset_t blk, old; sigemptyset(&blk); sigaddset(&blk, SIGUSR1);
  sigprocmask(SIG_BLOCK, &blk, &old);
  raise(SIGUSR1);
  sigset_t pend; sigpending(&pend);
  int was_pending = sigismember(&pend, SIGUSR1), hits_while_blocked = usr1_hits;
  sigprocmask(SIG_SETMASK, &old, 0);
  printf("blocked: pending=%d hits_while_blocked=%d hits_after_unblock=%d\n", was_pending, hits_while_blocked, usr1_hits);

  /* 3. setitimer + pause -> EINTR after SIGALRM */
  signal(SIGALRM, on_alrm);
  struct itimerval it; memset(&it, 0, sizeof it); it.it_value.tv_usec = 20000;   /* 20ms one-shot */
  setitimer(ITIMER_REAL, &it, 0);
  int r = pause();
  printf("pause: ret=%d errno=%s alrm_hits=%d\n", r, r == -1 && errno == EINTR ? "EINTR" : "other", alrm_hits);

  /* 4. nanosleep interrupted: no SA_RESTART -> EINTR */
  memset(&sa, 0, sizeof sa); sa.sa_handler = on_alrm; sigemptyset(&sa.sa_mask); sa.sa_flags = 0;
  sigaction(SIGALRM, &sa, 0);
  it.it_value.tv_usec = 20000; setitimer(ITIMER_REAL, &it, 0);
  struct timespec ts = { 5, 0 };
  errno = 0; r = nanosleep(&ts, 0);
  printf("nanosleep: ret=%d %s alrm_hits=%d\n", r, r == -1 && errno == EINTR ? "EINTR" : "other", alrm_hits);

  /* 5. SIGCHLD from a child's _exit, reaped in the handler */
  signal(SIGCHLD, on_chld);
  pid_t p = fork();
  if (p == 0) _exit(42);
  while (chld_hits == 0) pause();
  printf("chld hits=%d status=%d\n", chld_hits, chld_status);

  /* 6. sigsuspend: block USR2, raise it, sigsuspend with it unblocked */
  signal(SIGUSR2, on_usr2);
  sigset_t b2, all; sigemptyset(&b2); sigaddset(&b2, SIGUSR2);
  sigprocmask(SIG_BLOCK, &b2, &old);
  raise(SIGUSR2);
  sigemptyset(&all);
  r = sigsuspend(&all);
  sigprocmask(SIG_SETMASK, &old, 0);
  printf("sigsuspend: ret=%d %s usr2_hits=%d\n", r, r == -1 && errno == EINTR ? "EINTR" : "other", usr2_hits);

  /* 7. SA_RESETHAND: second raise takes the default (ignored for USR1? no: terminate) -> use USR2 with SIG_IGN fallback check */
  memset(&sa, 0, sizeof sa); sa.sa_handler = on_usr2; sa.sa_flags = SA_RESETHAND; sigemptyset(&sa.sa_mask);
  sigaction(SIGUSR2, &sa, 0);
  raise(SIGUSR2);
  struct sigaction cur; sigaction(SIGUSR2, 0, &cur);
  printf("resethand: hits=%d now_default=%d\n", usr2_hits, cur.sa_handler == SIG_DFL);
  return 0;
}
