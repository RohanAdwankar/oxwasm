// dlfail.c - ld.so's error path under translation: a failed dlsym and a
// failed dlopen both go _dl_catch_exception -> lookup -> _dl_signal_error ->
// _dl_signal_exception -> __longjmp back into the catcher. javac takes this
// path at runtime (the JVM probes optional symbols) and died in translated
// _dl_signal_exception. Loop so the functions tier up; print what dlerror says.
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
int main(void) {
  void *h = dlopen("libm.so.6", RTLD_NOW);
  if (!h) { printf("no libm: %s\n", dlerror()); return 1; }
  int misses = 0, opens = 0; const char *last = "";
  for (int i = 0; i < 300; i++) {
    if (dlsym(h, "no_such_symbol_xyz") == NULL) { misses++; const char *e = dlerror(); if (e && strstr(e, "undefined symbol")) last = "undefined symbol"; }
    if (dlopen("/nonexistent/lib.so", RTLD_NOW) == NULL) { opens++; (void)dlerror(); }
  }
  printf("misses %d opens %d last: %s\n", misses, opens, last);
  double (*c)(double) = (double (*)(double))dlsym(h, "cos");
  printf("cos(0)=%.1f\n", c ? c(0) : -1.0);
  return 0;
}
