/* Synthetic /proc and /dev (docs/m3-engine.md). Prints only facts that are
 * the same on any Linux box (no pids, addresses or CPU counts):
 *  - /proc/self/cmdline equals argv; /proc/self/environ carries PATH
 *  - /proc/self/maps has [stack] containing the current stack pointer, [heap],
 *    and the executable's path; /proc/self/status names the program
 *  - opening /proc/self/fd/N reads the same bytes as descriptor N
 *  - /dev/zero reads zeros; /dev/urandom reads the requested length
 *  - /proc/cpuinfo, /proc/meminfo, /proc/sys/kernel/osrelease are readable
 *  - pthread_getattr_np (glibc walks /proc/self/maps) reports a stack that
 *    contains a local variable
 *
 * Build:  gcc -O1 -pthread -o /tmp/breadth_procfs tools/fixtures/procfs.c
 */
#define _GNU_SOURCE
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>

static int slurp(const char *path, char *buf, int cap) {
  int fd = open(path, O_RDONLY); if (fd < 0) return -1;
  int n = 0, r; while (n < cap - 1 && (r = read(fd, buf + n, cap - 1 - n)) > 0) n += r;
  close(fd); buf[n] = 0; return n;
}
static int has(const char *hay, const char *needle) { return strstr(hay, needle) != 0; }

int main(int argc, char **argv) {
  static char buf[65536];
  (void)argc;
  int n = slurp("/proc/self/cmdline", buf, sizeof buf);
  printf("cmdline: matches=%d\n", n > 0 && strcmp(buf, argv[0]) == 0 && strcmp(buf + strlen(argv[0]) + 1, "alpha") == 0);
  setenv("BREADTH_MARK", "42", 1);
  n = slurp("/proc/self/environ", buf, sizeof buf);
  int envok = 0; for (char *q = buf; q < buf + n; q += strlen(q) + 1) if (!strncmp(q, "PATH=", 5)) envok = 1;
  printf("environ: has PATH=%d\n", envok);

  volatile char here = 1; unsigned long sp = (unsigned long)&here;
  n = slurp("/proc/self/maps", buf, sizeof buf);
  int stack_ok = 0;
  for (char *line = strtok(buf, "\n"); line; line = strtok(0, "\n")) {
    unsigned long lo, hi; if (sscanf(line, "%lx-%lx", &lo, &hi) == 2 && has(line, "[stack]") && sp >= lo && sp < hi) stack_ok = 1;
  }
  n = slurp("/proc/self/maps", buf, sizeof buf);
  printf("maps: stack_has_sp=%d heap=%d exe=%d\n", stack_ok, has(buf, "[heap]"), has(buf, argv[0]));
  n = slurp("/proc/self/status", buf, sizeof buf);
  printf("status: name=%d threads=%d\n", has(buf, "Name:\tbreadth_procfs"), has(buf, "Threads:\t"));

  int fd = open(argv[0], O_RDONLY); char a[64], b[64]; char pth[64];
  snprintf(pth, sizeof pth, "/proc/self/fd/%d", fd);
  int fd2 = open(pth, O_RDONLY);
  int ra = read(fd, a, 64), rb = read(fd2, b, 64);
  printf("proc-fd: reopen=%d same=%d\n", fd2 >= 0, ra == 64 && rb == 64 && !memcmp(a, b, 64));
  close(fd); close(fd2);

  int z = open("/dev/zero", O_RDONLY); char zb[16]; memset(zb, 1, 16); int zn = read(z, zb, 16); close(z);
  int allz = 1; for (int i = 0; i < 16; i++) if (zb[i]) allz = 0;
  int u = open("/dev/urandom", O_RDONLY); char ub[16]; int un = u >= 0 ? read(u, ub, 16) : -1; if (u >= 0) close(u);
  printf("dev: zero=%d urandom=%d\n", zn == 16 && allz, un == 16);

  printf("cpuinfo=%d meminfo=%d osrelease=%d\n",
         slurp("/proc/cpuinfo", buf, sizeof buf) > 0 && has(buf, "processor"),
         slurp("/proc/meminfo", buf, sizeof buf) > 0 && has(buf, "MemTotal:"),
         slurp("/proc/sys/kernel/osrelease", buf, sizeof buf) > 0);

  pthread_attr_t at; void *sa = 0; size_t ss = 0;
  int ok = pthread_getattr_np(pthread_self(), &at) == 0 && pthread_attr_getstack(&at, &sa, &ss) == 0;
  printf("getattr_np: ok=%d contains_local=%d\n", ok, ok && (char *)&here >= (char *)sa && (char *)&here < (char *)sa + ss);
  return 0;
}
