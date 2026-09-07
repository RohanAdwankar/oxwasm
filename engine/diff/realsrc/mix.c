// 32-bit arithmetic inside 64-bit registers: the width masks, sign and zero
// extensions, and the flag-setting shifts a real compiler emits when int and
// long meet. Called with a value wider than 32 bits so truncation shows.
long mix(long a, long b) {
  int x = (int)a * 3 + (int)b;
  unsigned u = (unsigned)x >> 3;
  long r = (long)x * b - (long)u;
  return r ^ (a >> 7) ^ (b << 2);
}
