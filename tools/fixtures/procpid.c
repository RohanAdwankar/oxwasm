/* Distinct pids, mmap coherence, /proc listings (docs/m3-engine.md).
 *  1. pids: the child's getpid() equals fork()'s return in the parent, the
 *     child's getppid() equals the parent's getpid(), and they differ.
 *  2. coherence file->map: a MAP_SHARED read mapping sees bytes written
 *     through a descriptor afterwards; map->file: a store through a shared
 *     writable mapping is visible to read() without msync.
 *  3. /proc listings: /proc has self and cpuinfo; /proc/self has maps and
 *     status; /proc/self/fd lists 0, 1, 2.
 * Output is program-determined (booleans and counts), so it byte-compares.
 *
 * Build:  gcc -O1 -o /tmp/breadth_procpid tools/fixtures/procpid.c
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/wait.h>

static int lists(const char *dir, const char *a, const char *b) {
  DIR *d = opendir(dir); if (!d) return 0; int ha = 0, hb = 0; struct dirent *e;
  while ((e = readdir(d))) { if (!strcmp(e->d_name, a)) ha = 1; if (!strcmp(e->d_name, b)) hb = 1; }
  closedir(d); return ha && hb;
}

int main(void) {
  /* 1 */
  int p[2]; if (pipe(p)) return 1;
  pid_t me = getpid(), c = fork();
  if (c == 0) { pid_t v[2] = { getpid(), getppid() }; if (write(p[1], v, sizeof v) != sizeof v) _exit(1); _exit(0); }
  close(p[1]); pid_t v[2] = { 0, 0 }; if (read(p[0], v, sizeof v) != sizeof v) return 1; close(p[0]);
  int st; waitpid(c, &st, 0);
  printf("pids: child_matches_fork=%d ppid_matches=%d distinct=%d\n", v[0] == c, v[1] == me, c != me);

  /* 2 */
  const char *path = "/tmp/breadth_procpid.dat";
  int fd = open(path, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (write(fd, "0123456789abcdef", 16) != 16) return 1;
  char *ro = mmap(0, 4096, PROT_READ, MAP_SHARED, fd, 0);
  if (pwrite(fd, "WXYZ", 4, 0) != 4) return 1;
  int file_to_map = !memcmp(ro, "WXYZ4567", 8);
  char *rw = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  memcpy(rw + 8, "QRST", 4);
  char buf[17] = {0}; if (pread(fd, buf, 16, 0) != 16) return 1;
  int map_to_file = !memcmp(buf, "WXYZ4567QRSTcdef", 16);
  printf("coherence: file_to_map=%d map_to_file=%d\n", file_to_map, map_to_file);
  munmap(ro, 4096); munmap(rw, 4096); close(fd); unlink(path);

  /* 3 */
  printf("proc-ls: root=%d self=%d fd=%d\n", lists("/proc", "self", "cpuinfo"), lists("/proc/self", "maps", "status"), lists("/proc/self/fd", "0", "2"));
  return 0;
}
