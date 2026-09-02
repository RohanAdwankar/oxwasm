/* Concurrency fixture (docs/m3-engine.md): real pthreads under contention.
 *
 * Eight threads each do 200k mutex-protected increments of a shared counter,
 * then the main thread joins them all and prints the total. The engine must
 * get clone(CLONE_VM|CLONE_THREAD), the futex-backed mutex, and its
 * park/wake/switchTo scheduler all right under contention: the printed total
 * is 8*200000 == 1600000 iff no increment is lost to a race and no thread
 * deadlocks or is dropped. The value is scheduling-order-independent (the
 * mutex serialises every update), so it byte-compares to native regardless of
 * how the cooperative scheduler interleaves the threads.
 *
 * Build:  gcc -O1 -pthread -o /tmp/breadth_thread tools/fixtures/thread.c
 */
#include <pthread.h>
#include <stdio.h>

#define N 8
#define ITERS 200000

static long counter = 0;
static pthread_mutex_t m = PTHREAD_MUTEX_INITIALIZER;

static void *worker(void *arg) {
  (void)arg;
  for (int i = 0; i < ITERS; i++) { pthread_mutex_lock(&m); counter++; pthread_mutex_unlock(&m); }
  return 0;
}

int main(void) {
  pthread_t t[N];
  for (int i = 0; i < N; i++) pthread_create(&t[i], 0, worker, 0);
  for (int i = 0; i < N; i++) pthread_join(t[i], 0);
  printf("counter=%ld\n", counter);
  return 0;
}
