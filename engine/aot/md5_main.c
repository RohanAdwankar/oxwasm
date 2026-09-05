#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
void md5_blocks(uint32_t*, const unsigned char*, uint64_t);
int main(int argc, char **argv) {
    FILE *f = fopen(argv[1], "rb");
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    long total = n + 1 + 8; long pad = (64 - total % 64) % 64; total += pad;
    unsigned char *buf = calloc(total, 1);
    fread(buf, 1, n, f);
    buf[n] = 0x80;
    uint64_t bits = (uint64_t)n * 8;
    memcpy(buf + total - 8, &bits, 8);
    uint32_t st[4] = {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476};
    md5_blocks(st, buf, total / 64);
    unsigned char *d = (unsigned char*)st;
    for (int i = 0; i < 16; i++) printf("%02x", d[i]);
    return 0;
}
