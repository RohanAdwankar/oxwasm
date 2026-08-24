/* Plain RFC-1321 MD5, all block processing in ONE self-contained function
 * (md5_blocks) so the AOT experiment translates a single compiled unit.
 * The machine code the translator consumes is unmodified clang -O2 output. */
#include <stdint.h>
#include "md5_k.h"

static const unsigned char S[64] = {
    7,12,17,22, 7,12,17,22, 7,12,17,22, 7,12,17,22,
    5, 9,14,20, 5, 9,14,20, 5, 9,14,20, 5, 9,14,20,
    4,11,16,23, 4,11,16,23, 4,11,16,23, 4,11,16,23,
    6,10,15,21, 6,10,15,21, 6,10,15,21, 6,10,15,21 };

__attribute__((noinline))
void md5_blocks(uint32_t *st, const unsigned char *data, uint64_t nblocks) {
    uint32_t a0 = st[0], b0 = st[1], c0 = st[2], d0 = st[3];
    for (uint64_t blk = 0; blk < nblocks; blk++) {
        const unsigned char *p = data + blk * 64;
        uint32_t M[16];
        for (int i = 0; i < 16; i++)
            M[i] = (uint32_t)p[i*4] | ((uint32_t)p[i*4+1] << 8) |
                   ((uint32_t)p[i*4+2] << 16) | ((uint32_t)p[i*4+3] << 24);
        uint32_t A = a0, B = b0, C = c0, D = d0;
        for (int i = 0; i < 64; i++) {
            uint32_t F, g;
            if (i < 16)      { F = (B & C) | (~B & D);        g = i; }
            else if (i < 32) { F = (D & B) | (~D & C);        g = (5*i + 1) & 15; }
            else if (i < 48) { F = B ^ C ^ D;                 g = (3*i + 5) & 15; }
            else             { F = C ^ (B | ~D);              g = (7*i) & 15; }
            F = F + A + K[i] + M[g];
            A = D; D = C; C = B;
            B = B + ((F << S[i]) | (F >> (32 - S[i])));
        }
        a0 += A; b0 += B; c0 += C; d0 += D;
    }
    st[0] = a0; st[1] = b0; st[2] = c0; st[3] = d0;
}
