// POSIX record locks across fork, plus OFD locks between two descriptions in
// one process. The engine used to grant every F_SETLK and report F_UNLCK from
// every F_GETLK; this pins the real semantics: conflict detection by byte
// range and lock type, the lock owned by the process and dropped when any fd
// on the file closes, OFD locks owned by the open file description.
#define _GNU_SOURCE
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <sys/wait.h>
static const char *res(int r) { return r ? strerror(errno) : "granted"; }
int main(void) {
  const char *p = "/tmp/breadth_rlock.dat";
  int fd = open(p, O_RDWR | O_CREAT | O_TRUNC, 0644);
  if (fd < 0 || write(fd, "0123456789", 10) != 10) { perror("setup"); return 1; }
  struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 2, .l_len = 4 };
  if (fcntl(fd, F_SETLK, &fl)) { perror("setlk"); return 1; }
  int pp[2]; if (pipe(pp)) return 1;
  pid_t c = fork();
  if (c == 0) {
    int fd2 = open(p, O_RDWR);
    struct flock q = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 10 };
    fcntl(fd2, F_GETLK, &q);
    printf("child getlk: type=%d start=%lld len=%lld pid_is_parent=%d\n", q.l_type, (long long)q.l_start, (long long)q.l_len, q.l_pid == getppid());
    struct flock s = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 3, .l_len = 1 };
    printf("child setlk overlapping: %s\n", res(fcntl(fd2, F_SETLK, &s)));
    struct flock s2 = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 7, .l_len = 2 };
    printf("child setlk disjoint: %s\n", res(fcntl(fd2, F_SETLK, &s2)));
    struct flock rd = { .l_type = F_RDLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 10 };
    printf("child rdlk over wrlk: %s\n", res(fcntl(fd2, F_SETLK, &rd)));
    fflush(stdout);
    if (write(pp[1], "x", 1) != 1) _exit(2);              // tell the parent to drop its lock
    struct flock w = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0 };
    printf("child setlkw after parent unlock: %s\n", res(fcntl(fd2, F_SETLKW, &w)));
    fflush(stdout); _exit(0);
  }
  char b; if (read(pp[0], &b, 1) != 1) return 1;
  int fd3 = open(p, O_RDONLY); close(fd3);                // closing ANY fd on the file drops the process's locks
  int st; waitpid(c, &st, 0);
  printf("parent: child exit %d\n", WEXITSTATUS(st));
  int fa = open(p, O_RDWR), fb = open(p, O_RDWR);
  struct flock o = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0, .l_pid = 0 };
  printf("ofd a: %s\n", res(fcntl(fa, F_OFD_SETLK, &o)));
  printf("ofd b: %s\n", res(fcntl(fb, F_OFD_SETLK, &o)));
  struct flock g = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 0, .l_pid = 0 };
  fcntl(fb, F_OFD_GETLK, &g);
  printf("ofd getlk b: type=%d pid=%d\n", g.l_type, g.l_pid);
  close(fa);
  printf("ofd b after a closed: %s\n", res(fcntl(fb, F_OFD_SETLK, &o)));
  unlink(p);
  return 0;
}
