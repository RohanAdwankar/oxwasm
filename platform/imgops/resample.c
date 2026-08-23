/* oxwasm platform — generic image ops for the M4 (recompile) lane.
 *
 * Separable bicubic (Catmull-Rom) RGBA8 resample with precomputed weight
 * tables and explicit 4-lane float vectors. The vector type lowers to SSE
 * natively and to wasm SIMD128 under clang wasm32 — the SAME C file, the
 * same instruction shapes, on both targets. Freestanding: no libc, no
 * malloc; the caller provides all buffers in linear memory.
 */
#include <stdint.h>

typedef float f32x4 __attribute__((vector_size(16)));
typedef uint8_t u8x4 __attribute__((vector_size(4)));
typedef uint32_t u32x4 __attribute__((vector_size(16)));

static inline float cubic(float t) {            /* Catmull-Rom, a = -0.5 */
    float at = t < 0 ? -t : t;
    if (at <= 1.0f) return 1.0f - at*at*(2.5f - 1.5f*at);
    if (at <  2.0f) return 2.0f - at*(4.0f - at*(2.5f - 0.5f*at));
    return 0.0f;
}
static inline int clampi(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Weight/tap tables live in caller-provided scratch:
 *   taps: n*4 int32 (clamped source indices), wts: n*4 float */
static void build_tables(int sn, int dn, int32_t *taps, float *wts) {
    float r = (float)sn / dn;
    for (int o = 0; o < dn; o++) {
        float s = (o + 0.5f) * r - 0.5f;
        int i = (int)s - (s < 0);
        float f = s - i;
        for (int k = 0; k < 4; k++) {
            taps[o*4 + k] = clampi(i + k - 1, 0, sn - 1);
            wts[o*4 + k] = cubic(f - (k - 1));
        }
    }
}

#ifdef __wasm__
__attribute__((export_name("resample")))
#endif
void resample(const uint8_t *src, int sw, int sh, uint8_t *dst, int dw, int dh,
              f32x4 *mid, int32_t *taps, float *wts) {
    /* horizontal: src (sw x sh, u8) -> mid (dw x sh, f32x4) */
    build_tables(sw, dw, taps, wts);
    for (int y = 0; y < sh; y++) {
        const uint8_t *row = src + (uint32_t)y * sw * 4;
        f32x4 *out = mid + (uint32_t)y * dw;
        for (int o = 0; o < dw; o++) {
            const int32_t *t = taps + o*4; const float *w = wts + o*4;
            f32x4 acc = {0, 0, 0, 0};
            for (int k = 0; k < 4; k++) {
                const u8x4 *p = (const u8x4 *)(row + (uint32_t)t[k] * 4);
                acc += w[k] * __builtin_convertvector(*p, f32x4);
            }
            out[o] = acc;
        }
    }
    /* vertical: mid (dw x sh) -> dst (dw x dh, u8) */
    build_tables(sh, dh, taps, wts);
    for (int o = 0; o < dh; o++) {
        const int32_t *t = taps + o*4; const float *w = wts + o*4;
        const f32x4 *r0 = mid + (uint32_t)t[0] * dw, *r1 = mid + (uint32_t)t[1] * dw;
        const f32x4 *r2 = mid + (uint32_t)t[2] * dw, *r3 = mid + (uint32_t)t[3] * dw;
        f32x4 w0 = {w[0],w[0],w[0],w[0]}, w1 = {w[1],w[1],w[1],w[1]};
        f32x4 w2 = {w[2],w[2],w[2],w[2]}, w3 = {w[3],w[3],w[3],w[3]};
        uint8_t *q = dst + (uint32_t)o * dw * 4;
        const f32x4 zero = {0,0,0,0}, top = {255,255,255,255}, half = {0.5f,0.5f,0.5f,0.5f};
#define PIX(x) do { \
            f32x4 acc = w0*r0[x] + w1*r1[x] + w2*r2[x] + w3*r3[x]; \
            u32x4 mpos = (u32x4)(acc > zero); \
            f32x4 lo = (f32x4)(mpos & (u32x4)acc); \
            u32x4 mtop = (u32x4)(lo < top); \
            f32x4 cl = (f32x4)((mtop & (u32x4)lo) | (~mtop & (u32x4)top)); \
            *(u8x4 *)(q + (x)*4) = __builtin_convertvector(cl + half, u8x4); \
        } while (0)
        int x = 0;
        for (; x + 4 <= dw; x += 4) { PIX(x); PIX(x+1); PIX(x+2); PIX(x+3); }
        for (; x < dw; x++) PIX(x);
#undef PIX
    }
}

#ifdef __wasm__
__attribute__((export_name("checksum")))
#endif
uint32_t checksum(const uint8_t *p, uint32_t n) {
    uint32_t h = 2166136261u;
    for (uint32_t i = 0; i < n; i++) { h ^= p[i]; h *= 16777619u; }
    return h;
}

#ifdef __wasm__
__attribute__((export_name("fill")))
#endif
void fill(uint8_t *p, int w, int h) {
    for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
        uint8_t *q = p + ((uint32_t)y * w + x) * 4;
        q[0] = (uint8_t)(x * 7 + y * 3); q[1] = (uint8_t)(x ^ y);
        q[2] = (uint8_t)(x * 2 + y * 5); q[3] = 255;
    }
}
