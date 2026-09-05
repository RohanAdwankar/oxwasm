#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
typedef float f32x4 __attribute__((vector_size(16)));
void resample(const uint8_t*, int, int, uint8_t*, int, int, f32x4*, int32_t*, float*);
uint32_t checksum(const uint8_t*, uint32_t);
void fill(uint8_t*, int, int);
int main(int argc, char **argv) {
    int sw = atoi(argv[1]), dw = atoi(argv[2]);
    uint8_t *src = malloc((size_t)sw*sw*4), *dst = malloc((size_t)dw*dw*4);
    f32x4 *mid = malloc((size_t)dw*sw*16);
    int32_t *taps = malloc((size_t)dw*4*4 > (size_t)sw*16 ? (size_t)dw*16 : (size_t)sw*16);
    float *wts = malloc((size_t)dw*16);
    fill(src, sw, sw);
    for (long i = 0; i < (long)dw*dw*4; i += 4096) dst[i] = 0;   /* pre-touch */
    double best = 1e18;
    for (int rep = 0; rep < 4; rep++) {
        struct timespec a, b; clock_gettime(CLOCK_MONOTONIC, &a);
        resample(src, sw, sw, dst, dw, dw, mid, taps, wts);
        clock_gettime(CLOCK_MONOTONIC, &b);
        double s = (b.tv_sec-a.tv_sec) + (b.tv_nsec-a.tv_nsec)/1e9;
        if (s < best) best = s;
    }
    printf("native %dx%d -> %dx%d: best %.3f s  checksum=%08x\n", sw, sw, dw, dw, best, checksum(dst, (uint32_t)((long)dw*dw*4)));
    return 0;
}
