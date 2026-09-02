/* Timers and signal descriptors (docs/m3-engine.md), machine-invariant output.
 *  1. timerfd one-shot: read blocks until expiry and returns count 1
 *  2. timerfd interval: poll() reports it readable, read returns >= 1
 *  3. signalfd: SIGUSR1 blocked and raised, read gives ssi_signo/ssi_code
 *  4. sigtimedwait: SIGUSR2 blocked and raised -> returns it with SI_TKILL;
 *     with nothing pending and a zero timeout -> -1/EAGAIN
 *  5. timer_create(SIGEV_SIGNAL, SIGRTMIN, sival 77) + timer_settime: the
 *     SA_SIGINFO handler sees si_code SI_TIMER and si_value 77
 *  6. setitimer(ITIMER_VIRTUAL): SIGVTALRM arrives while spinning (with an
 *     occasional syscall, as a profiled program does)
 *
 * Build:  gcc -O1 -o /tmp/breadth_timers tools/fixtures/timers.c
 */
#define _GNU_SOURCE
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <time.h>
#include <unistd.h>
#include <poll.h>
#include <sys/time.h>
#include <sys/timerfd.h>
#include <sys/signalfd.h>

static volatile int rt_code, rt_val, rt_hits, vt_hits;
static void on_rt(int s, siginfo_t *si, void *u) { (void)s; (void)u; rt_hits++; rt_code = si->si_code; rt_val = si->si_value.sival_int; }
static void on_vt(int s) { (void)s; vt_hits++; }

int main(void) {
  /* 1 */
  int tf = timerfd_create(CLOCK_MONOTONIC, 0);
  struct itimerspec its; memset(&its, 0, sizeof its); its.it_value.tv_nsec = 15000000;   /* 15ms */
  timerfd_settime(tf, 0, &its, 0);
  unsigned long long cnt = 0; ssize_t r = read(tf, &cnt, sizeof cnt);
  printf("timerfd-oneshot: r=%zd count=%llu\n", r, cnt);
  /* 2 */
  its.it_value.tv_nsec = 5000000; its.it_interval.tv_nsec = 5000000;
  timerfd_settime(tf, 0, &its, 0);
  struct pollfd pf = { tf, POLLIN, 0 }; int pr = poll(&pf, 1, 2000);
  cnt = 0; r = read(tf, &cnt, sizeof cnt);
  printf("timerfd-interval: poll=%d pollin=%d r=%zd count_ge1=%d\n", pr, !!(pf.revents & POLLIN), r, cnt >= 1);
  close(tf);
  /* 3 */
  sigset_t m; sigemptyset(&m); sigaddset(&m, SIGUSR1); sigprocmask(SIG_BLOCK, &m, 0);
  int sf = signalfd(-1, &m, 0);
  raise(SIGUSR1);
  struct signalfd_siginfo si; r = read(sf, &si, sizeof si);
  printf("signalfd: r=%zd signo=%d code_tkill=%d\n", r, (int)si.ssi_signo, si.ssi_code == SI_TKILL);
  close(sf);
  /* 4 */
  sigemptyset(&m); sigaddset(&m, SIGUSR2); sigprocmask(SIG_BLOCK, &m, 0);
  raise(SIGUSR2);
  siginfo_t info; struct timespec zero = { 0, 0 };
  int got = sigtimedwait(&m, &info, &zero);
  errno = 0; int none = sigtimedwait(&m, &info, &zero);
  printf("sigtimedwait: got=%d code_tkill=%d then=%d %s\n", got, info.si_code == SI_TKILL, none, none == -1 && errno == EAGAIN ? "EAGAIN" : "other");
  /* 5 */
  struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_sigaction = on_rt; sa.sa_flags = SA_SIGINFO; sigemptyset(&sa.sa_mask);
  sigaction(SIGRTMIN, &sa, 0);
  struct sigevent sev; memset(&sev, 0, sizeof sev); sev.sigev_notify = SIGEV_SIGNAL; sev.sigev_signo = SIGRTMIN; sev.sigev_value.sival_int = 77;
  timer_t tid; int tc = timer_create(CLOCK_MONOTONIC, &sev, &tid);
  memset(&its, 0, sizeof its); its.it_value.tv_nsec = 10000000;
  timer_settime(tid, 0, &its, 0);
  while (rt_hits == 0) pause();
  timer_delete(tid);
  printf("posix-timer: create=%d hits=%d si_timer=%d value=%d\n", tc, rt_hits, rt_code == SI_TIMER, rt_val);
  /* 6 */
  signal(SIGVTALRM, on_vt);
  struct itimerval iv; memset(&iv, 0, sizeof iv); iv.it_value.tv_usec = 10000;
  setitimer(ITIMER_VIRTUAL, &iv, 0);
  /* spin the way a profiled program does — making syscalls — rather than a
     bare loop the engine's compiled tier cannot interrupt */
  volatile unsigned long spin = 0; while (vt_hits == 0 && spin < 400000000UL) { spin++; if ((spin & 1023) == 0) getppid(); }
  printf("itimer-virtual: hits=%d\n", vt_hits);
  return 0;
}
