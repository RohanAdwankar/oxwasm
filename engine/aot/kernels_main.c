#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
uint64_t fnv1a(const unsigned char*, uint64_t);
int64_t saxpy_sum(const int32_t*, const int32_t*, uint64_t, int32_t);
uint64_t collatz_total(uint64_t);
static double ms(){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec*1e3+t.tv_nsec/1e6; }
int main(int argc,char**argv){
  int which = argc>1?atoi(argv[1]):0;
  if(which==0){ size_t n=16<<20; unsigned char*b=malloc(n); for(size_t i=0;i<n;i++)b[i]=(i*2654435761u)>>24;
    double best=1e18; uint64_t h=0; for(int r=0;r<10;r++){double t=ms(); h=fnv1a(b,n); double d=ms()-t; if(d<best)best=d;}
    printf("fnv1a=%016llx %.2f ms\n",(unsigned long long)h,best); }
  else if(which==1){ size_t n=8<<20; int32_t*x=malloc(n*4),*y=malloc(n*4); for(size_t i=0;i<n;i++){x[i]=(int)(i*2654435761u);y[i]=(int)i-3;}
    double best=1e18; int64_t s=0; for(int r=0;r<10;r++){double t=ms(); s=saxpy_sum(x,y,n,7); double d=ms()-t; if(d<best)best=d;}
    printf("saxpy=%lld %.2f ms\n",(long long)s,best); }
  else { uint64_t n=2000000; double best=1e18; uint64_t s=0; for(int r=0;r<5;r++){double t=ms(); s=collatz_total(n); double d=ms()-t; if(d<best)best=d;}
    printf("collatz=%llu %.2f ms\n",(unsigned long long)s,best); }
  return 0;
}
