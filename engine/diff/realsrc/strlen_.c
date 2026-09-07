// A hand-written strlen: at -O2 gcc vectorizes it, which is the point - the
// blob exercises the SSE string path against hardware. Named with a trailing
// underscore and built -fno-builtin so it cannot become a call to libc's.
unsigned long strlen_(const char *s) {
  const char *p = s;
  while (*p) p++;
  return (unsigned long)(p - s);
}
