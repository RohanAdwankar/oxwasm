/* Minimal reproducer for the fork+AOT corruption (docs/m3-engine.md).
 *
 * Build a fully static, non-PIE executable and run it under the engine both
 * with the AOT tier on and off:
 *
 *   gcc -O1 -static -no-pie -o /tmp/vforkexec tools/fixtures/vforkexec.c
 *
 * Native: prints "survived". Engine with AOT off: prints "survived".
 * Engine with AOT on: faults ("unsupported opcode .. at <stack addr>").
 *
 * The shape that matters: tier a function (the first hot() call), then vfork
 * and have the child execve a *static* binary (so no ld.so provisioning is
 * needed), then keep running in the parent. With AOT on, the vfork child does
 * not stop after its execve — it runs on down __execve's error-return path and
 * rets through a corrupted stack slot. The corrupting store is a compiled
 * (wasm) store, invisible to interpreter-level write tracing; no-AOT and
 * AOT-without-fork are both clean, so it is specifically the interaction of a
 * tiered parent with the vfork/execve thread hand-off. GIMP's plug-in
 * launcher (fork+exec) avoids it; gcc's driver (vfork+exec of cc1) hits it.
 */
#include <unistd.h>
#include <sys/wait.h>

static long hot(long n) { volatile long s = 0; for (long i = 0; i < n; i++) s += i % 7; return s; }

int main(void) {
  hot(4000000);                                   /* tier this function */
  pid_t p = vfork();
  if (p == 0) { execl("/usr/bin/busybox", "busybox", "true", (char *)0); _exit(127); }
  int st; waitpid(p, &st, 0);
  long r = hot(4000000);                          /* the parent must survive the window */
  if (r >= 0) { const char *m = "survived\n"; ssize_t w = write(1, m, 9); (void)w; }
  return 0;
}
