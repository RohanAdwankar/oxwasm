// census.c - a census of less-common syscalls, each printed as name=ret/errno
// so native and engine outputs compare byte for byte. What the ordinary
// breadth binaries never call: eventfd, timerfd, signalfd, memfd, inotify,
// epoll over an eventfd, pipe2 flags, sendfile/splice/copy_file_range,
// statx, fallocate, xattrs, utimensat, renameat2, sched/affinity, sysinfo,
// prlimit, getcpu, tgkill(0).
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <sched.h>
#include <sys/eventfd.h>
#include <sys/timerfd.h>
#include <sys/signalfd.h>
#include <sys/mman.h>
#include <sys/inotify.h>
#include <sys/epoll.h>
#include <sys/sendfile.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <sys/sysinfo.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/file.h>
#include <time.h>
#include <stdint.h>
#include <poll.h>
#include <sys/random.h>
#define R(name, expr) do { errno = 0; long _r = (long)(expr); int _e = errno; printf("%s=%ld/%d\n", name, _r < 0 ? -1L : (_r > 1000000 ? 1L : _r), _r < 0 ? _e : 0); } while (0)
int main(void) {
  char dir[] = "/tmp/census_XXXXXX"; if (!mkdtemp(dir)) return 1;
  char p1[300], p2[300]; snprintf(p1, sizeof p1, "%s/a", dir); snprintf(p2, sizeof p2, "%s/b", dir);
  int fd = open(p1, O_CREAT | O_RDWR, 0644); R("open", fd);
  R("write", write(fd, "0123456789abcdef", 16));
  R("fallocate", fallocate(fd, 0, 0, 4096));
  R("posix_fadvise", posix_fadvise(fd, 0, 0, POSIX_FADV_SEQUENTIAL));
  struct statx sx; R("statx", statx(AT_FDCWD, p1, 0, STATX_BASIC_STATS, &sx)); printf("statx.size=%llu mode=%o\n", (unsigned long long)sx.stx_size, sx.stx_mode & 0777);
  R("fsetxattr", fsetxattr(fd, "user.census", "v", 1, 0));
  char xb[8]; R("fgetxattr", fgetxattr(fd, "user.census", xb, sizeof xb));
  struct timespec ts[2] = { { 1600000000, 0 }, { 1600000001, 0 } }; R("utimensat", utimensat(AT_FDCWD, p1, ts, 0));
  struct stat st; stat(p1, &st); printf("mtime=%ld\n", (long)st.st_mtime);
  R("renameat2", renameat2(AT_FDCWD, p1, AT_FDCWD, p2, RENAME_NOREPLACE));
  R("renameat2-exch", renameat2(AT_FDCWD, p2, AT_FDCWD, p1, RENAME_EXCHANGE));
  R("flock", flock(fd, LOCK_EX | LOCK_NB));
  int fd2 = open(p2, O_CREAT | O_RDWR, 0644); R("open2", fd2);
  lseek(fd, 0, SEEK_SET); off_t off = 0; R("sendfile", sendfile(fd2, fd, &off, 16));
  R("copy_file_range", copy_file_range(fd, &(loff_t){0}, fd2, &(loff_t){16}, 16, 0));
  int pp[2]; R("pipe2", pipe2(pp, O_NONBLOCK | O_CLOEXEC)); R("fcntl-getfl", fcntl(pp[0], F_GETFL) & O_NONBLOCK);
  lseek(fd, 0, SEEK_SET); R("splice-in", splice(fd, NULL, pp[1], NULL, 16, 0)); R("splice-out", splice(pp[0], NULL, fd2, NULL, 16, 0));
  R("read-empty-nonblock", read(pp[0], xb, 1));
  int efd = eventfd(5, EFD_NONBLOCK); R("eventfd", efd); uint64_t v; R("eventfd-read", read(efd, &v, 8)); printf("efd.v=%llu\n", (unsigned long long)v); R("eventfd-read-empty", read(efd, &v, 8));
  R("eventfd-write", write(efd, &(uint64_t){3}, 8));
  int ep = epoll_create1(EPOLL_CLOEXEC); R("epoll_create1", ep); struct epoll_event ev = { .events = EPOLLIN, .data.u32 = 7 };
  R("epoll_ctl", epoll_ctl(ep, EPOLL_CTL_ADD, efd, &ev)); struct epoll_event out[2]; R("epoll_wait", epoll_wait(ep, out, 2, 0)); printf("ep.data=%u\n", out[0].data.u32);
  int tfd = timerfd_create(CLOCK_MONOTONIC, TFD_NONBLOCK); R("timerfd_create", tfd);
  struct itimerspec its = { .it_value = { 0, 1000000 } }; R("timerfd_settime", timerfd_settime(tfd, 0, &its, NULL));
  struct pollfd pf = { .fd = tfd, .events = POLLIN }; R("poll-timerfd", poll(&pf, 1, 500)); R("timerfd-read", read(tfd, &v, 8)); printf("tfd.v=%llu\n", (unsigned long long)v);
  sigset_t m; sigemptyset(&m); sigaddset(&m, SIGUSR1); sigprocmask(SIG_BLOCK, &m, NULL);
  int sfd = signalfd(-1, &m, SFD_NONBLOCK); R("signalfd", sfd); kill(getpid(), SIGUSR1); struct signalfd_siginfo si; R("signalfd-read", read(sfd, &si, sizeof si)); printf("sfd.signo=%u\n", si.ssi_signo);
  int mfd = memfd_create("census", MFD_CLOEXEC); R("memfd_create", mfd); R("ftruncate", ftruncate(mfd, 8192));
  char *mp = mmap(NULL, 8192, PROT_READ | PROT_WRITE, MAP_SHARED, mfd, 0); R("mmap-memfd", mp == MAP_FAILED ? -1 : 0); if (mp != MAP_FAILED) { mp[100] = 'Z'; char c; pread(mfd, &c, 1, 100); printf("memfd.byte=%c\n", c); }
  int ifd = inotify_init1(IN_NONBLOCK); R("inotify_init1", ifd); R("inotify_add_watch", inotify_add_watch(ifd, dir, IN_CREATE | IN_DELETE));
  int fd3 = open(p1, O_CREAT | O_RDWR, 0644); close(fd3); char ib[512]; long n = read(ifd, ib, sizeof ib); R("inotify-read", n); if (n > 0) { struct inotify_event *e = (void *)ib; printf("inotify.mask=%x name=%s\n", e->mask, e->len ? e->name : ""); }
  struct sysinfo sinf; R("sysinfo", sysinfo(&sinf)); printf("sysinfo.procs>0=%d\n", sinf.procs > 0);
  struct utsname u; R("uname", uname(&u)); printf("sysname=%s\n", u.sysname);
  struct rlimit rl; R("prlimit64", prlimit(0, RLIMIT_NOFILE, NULL, &rl)); printf("nofile>=256=%d\n", rl.rlim_cur >= 256);
  cpu_set_t cs; R("sched_getaffinity", sched_getaffinity(0, sizeof cs, &cs)); printf("cpus>=1=%d\n", CPU_COUNT(&cs) >= 1);
  unsigned cpu = 99, node = 99; R("getcpu", syscall(SYS_getcpu, &cpu, &node, NULL)); printf("cpu<4096=%d\n", cpu < 4096);
  R("sched_yield", sched_yield());
  R("gettid==getpid", syscall(SYS_gettid) == getpid());
  R("tgkill0", syscall(SYS_tgkill, getpid(), syscall(SYS_gettid), 0));
  struct timespec res; R("clock_getres", clock_getres(CLOCK_MONOTONIC, &res)); printf("res.ns<=1000000=%d\n", res.tv_nsec <= 1000000);
  R("nanosleep", nanosleep(&(struct timespec){0, 1000000}, NULL));
  char lb[300]; R("symlinkat", symlinkat("a", AT_FDCWD, p2)); R("readlinkat", readlinkat(AT_FDCWD, p2, lb, sizeof lb));
  R("fchmodat", fchmodat(AT_FDCWD, p1, 0600, 0)); stat(p1, &st); printf("mode=%o\n", st.st_mode & 0777);
  R("unlinkat", unlinkat(AT_FDCWD, p2, 0)); R("unlinkat-a", unlinkat(AT_FDCWD, p1, 0)); R("rmdir", rmdir(dir));
  R("getrandom-len", getrandom(xb, 8, 0));
  puts("done"); return 0;
}
