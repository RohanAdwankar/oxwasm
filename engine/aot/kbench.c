#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
uint64_t fnv1a(const unsigned char*, uint64_t);
int64_t saxpy_sum(const int32_t*, const int32_t*, uint64_t, int32_t);
uint64_t collatz_total(uint64_t);
static double ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
#define BEST(CALL, ITERS) ({ double _bb=1e18; for(int r=0;r<ITERS;r++){ double t=ms(); CALL; double d=ms()-t; if(d<_bb)_bb=d; } _bb; })
int main(){
  uint64_t N1=1048576;
  unsigned char*b=malloc(N1); for(uint64_t i=0;i<N1;i++) b[i]=(i*2654435761u)>>24;
  volatile uint64_t h; double t1=BEST(h=fnv1a(b,N1),50); printf("fnv1a   N=%lu: %.3f ms\n",N1,t1);
  int32_t*x=malloc(N1*4),*y=malloc(N1*4); for(uint64_t i=0;i<N1;i++){x[i]=(int)(i*2654435761u);y[i]=(int)i-3;}
  volatile int64_t s; double t2=BEST(s=saxpy_sum(x,y,N1,7),50); printf("saxpy   N=%lu: %.3f ms\n",N1,t2);
  volatile uint64_t c; double t3=BEST(c=collatz_total(200000),50); printf("collatz N=200000: %.3f ms\n",t3);
  return 0;
}
