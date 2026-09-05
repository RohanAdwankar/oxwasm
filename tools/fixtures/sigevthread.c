// timer_create(SIGEV_THREAD): glibc starts a helper thread and asks the
// kernel for SIGEV_THREAD_ID delivery of SIGTIMER to it; the helper sigwaits
// and runs the callback. The engine refused SIGEV_THREAD with EINVAL and had
// no thread-directed timer delivery at all.
#include <signal.h>
#include <time.h>
#include <stdio.h>
#include <stdatomic.h>
static atomic_int n;
static void cb(union sigval v) { if (v.sival_int == 7) atomic_fetch_add(&n, 1); }
int main(void) {
  timer_t t; struct sigevent se = { 0 };
  se.sigev_notify = SIGEV_THREAD; se.sigev_notify_function = cb; se.sigev_value.sival_int = 7;
  if (timer_create(CLOCK_MONOTONIC, &se, &t)) { perror("timer_create"); return 1; }
  struct itimerspec its = { { 0, 5000000 }, { 0, 5000000 } };
  if (timer_settime(t, 0, &its, 0)) { perror("timer_settime"); return 1; }
  for (int i = 0; i < 600 && atomic_load(&n) < 3; i++) { struct timespec ts = { 0, 5000000 }; nanosleep(&ts, 0); }
  timer_delete(t);
  printf("fired>=3: %d\n", atomic_load(&n) >= 3);
  return 0;
}
