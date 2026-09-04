#include <pthread.h>
#include <stdio.h>
#include <time.h>
#include <errno.h>
static long ms_since(struct timespec *a){ struct timespec b; clock_gettime(CLOCK_MONOTONIC,&b); return (b.tv_sec-a->tv_sec)*1000+(b.tv_nsec-a->tv_nsec)/1000000; }
static void run(int clk, const char *name){
  pthread_mutex_t m=PTHREAD_MUTEX_INITIALIZER; pthread_cond_t c; pthread_condattr_t at; pthread_condattr_init(&at);
  if(clk>=0) pthread_condattr_setclock(&at, clk); pthread_cond_init(&c,&at);
  struct timespec t0, dl; clock_gettime(CLOCK_MONOTONIC,&t0);
  clock_gettime(clk>=0?clk:CLOCK_REALTIME,&dl); dl.tv_nsec+=150000000; if(dl.tv_nsec>=1000000000){dl.tv_sec++;dl.tv_nsec-=1000000000;}
  pthread_mutex_lock(&m); int loops=0, rc=0;
  while(loops<50){ rc=pthread_cond_timedwait(&c,&m,&dl); loops++; if(rc==ETIMEDOUT) break; }
  pthread_mutex_unlock(&m);
  long el=ms_since(&t0); printf("%s: rc=%s loops=%d elapsed=%s\n", name, rc==ETIMEDOUT?"ETIMEDOUT":"other", loops, el>=100&&el<2000?"ok(100-2000ms)":(el<100?"TOO-FAST":"too-slow"));
}
int main(){ run(-1,"realtime-default"); run(CLOCK_MONOTONIC,"monotonic"); run(CLOCK_REALTIME,"realtime"); return 0; }
