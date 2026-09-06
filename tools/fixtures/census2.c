// census2.c - the second syscall census: processes, signals, sockets and
// memory, each printed as name=ret/errno so native and engine outputs
// compare byte for byte. What census.c left out: prctl names, personality,
// sigaltstack, sigqueue, sigtimedwait, sigpending, pidfd, waitid, getrusage,
// times, setitimer, session/process groups, umask, groups, mincore, msync,
// madvise, mremap, AF_UNIX and loopback sockets with sendmsg/recvmsg and
// SCM_RIGHTS, socket options, shutdown, dup3, F_DUPFD_CLOEXEC, getdents64,
// statfs, ioctl on a non-tty, ppoll with a timeout, readv/writev, pwritev.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <dirent.h>
#include <stdint.h>
#include <time.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/personality.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <sys/times.h>
#include <sys/time.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/uio.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#define R(name, expr) do { errno = 0; long _r = (long)(expr); int _e = errno; printf("%s=%ld/%d\n", name, _r < 0 ? -1L : (_r > 1000000 ? 1L : _r), _r < 0 ? _e : 0); } while (0)
static volatile int got, gotval;
static void h(int s, siginfo_t *si, void *u) { (void)u; got = s; gotval = si->si_code == SI_QUEUE ? si->si_value.sival_int : -1; }
int main(void) {
  char nm[17] = {0};
  R("prctl-setname", prctl(PR_SET_NAME, "census2x")); R("prctl-getname", prctl(PR_GET_NAME, nm)); printf("name=%s\n", nm);
  R("prctl-getdumpable", prctl(PR_GET_DUMPABLE)); R("prctl-pdeathsig", prctl(PR_SET_PDEATHSIG, 0));
  R("personality", personality(0xffffffff) & PER_MASK);
  R("umask", umask(022)); R("umask2", umask(022));
  R("getpgid", getpgid(0) > 0); R("setpgid", setpgid(0, 0)); R("getsid", getsid(0) > 0);
  gid_t gs[64]; R("getgroups", getgroups(64, gs) >= 0);
  R("getpriority", getpriority(PRIO_PROCESS, 0)); R("setpriority", setpriority(PRIO_PROCESS, 0, 0));
  struct rusage ru; R("getrusage", getrusage(RUSAGE_SELF, &ru)); struct tms t; R("times", times(&t) >= 0);
  // signals
  struct sigaction sa = { .sa_sigaction = h, .sa_flags = SA_SIGINFO }; sigemptyset(&sa.sa_mask);
  R("sigaction", sigaction(SIGUSR1, &sa, NULL)); R("sigaction2", sigaction(SIGUSR2, &sa, NULL));
  R("sigqueue", sigqueue(getpid(), SIGUSR1, (union sigval){ .sival_int = 42 })); printf("got=%d val=%d\n", got, gotval);
  R("raise", raise(SIGUSR2)); printf("got=%d val=%d\n", got, gotval);
  sigset_t blk, pend; sigemptyset(&blk); sigaddset(&blk, SIGUSR1);
  R("sigprocmask", sigprocmask(SIG_BLOCK, &blk, NULL)); got = 0; R("kill-blocked", kill(getpid(), SIGUSR1));
  R("sigpending", sigpending(&pend)); printf("pending=%d got=%d\n", sigismember(&pend, SIGUSR1), got);
  siginfo_t si; struct timespec zero = { 0, 0 }; R("sigtimedwait", sigtimedwait(&blk, &si, &zero)); printf("si_signo=%d got=%d\n", si.si_signo, got);
  R("sigtimedwait-empty", sigtimedwait(&blk, &si, &zero));
  R("sigprocmask-unblock", sigprocmask(SIG_UNBLOCK, &blk, NULL));
  static char stk[1 << 16]; stack_t ss = { .ss_sp = stk, .ss_size = sizeof stk }, oss;
  R("sigaltstack", sigaltstack(&ss, NULL)); R("sigaltstack-get", sigaltstack(NULL, &oss)); printf("ss.size=%zu flags=%d\n", oss.ss_size, oss.ss_flags);
  R("pause-alarm", (signal(SIGALRM, SIG_IGN), 0)); struct itimerval it = { { 0, 0 }, { 0, 1000 } }, oit;
  R("setitimer", setitimer(ITIMER_REAL, &it, NULL)); R("getitimer", getitimer(ITIMER_REAL, &oit)); R("setitimer-off", setitimer(ITIMER_REAL, &(struct itimerval){ 0 }, NULL));
  // children
  pid_t c = fork(); if (c == 0) _exit(7);
  R("pidfd_open", syscall(SYS_pidfd_open, c, 0) >= 0);
  siginfo_t wi; memset(&wi, 0, sizeof wi); R("waitid", waitid(P_PID, c, &wi, WEXITED)); printf("wi.status=%d code=%d\n", wi.si_status, wi.si_code == CLD_EXITED);
  c = fork(); if (c == 0) { pause(); _exit(0); } usleep(20000);
  R("kill-child", kill(c, SIGTERM)); int st = 0; R("wait4", wait4(c, &st, 0, &ru) == c); printf("termsig=%d\n", WIFSIGNALED(st) ? WTERMSIG(st) : -1);
  R("waitpid-none", waitpid(-1, &st, WNOHANG));
  // memory
  size_t ps = sysconf(_SC_PAGESIZE); char *m = mmap(NULL, 4 * ps, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0); R("mmap", m != MAP_FAILED);
  m[0] = 1; m[ps] = 2; unsigned char vec[4]; R("mincore", mincore(m, 4 * ps, vec));
  R("madvise-dontneed", madvise(m, ps, MADV_DONTNEED)); printf("after-dontneed=%d\n", m[0]);
  R("madvise-bad", madvise(m + 1, ps, MADV_DONTNEED));
  char *m2 = mremap(m, 4 * ps, 8 * ps, MREMAP_MAYMOVE); R("mremap", m2 != MAP_FAILED); printf("kept=%d\n", m2[ps]); m2[7 * ps] = 3;
  R("msync", msync(m2, ps, MS_SYNC)); R("mprotect", mprotect(m2, ps, PROT_READ)); R("munmap", munmap(m2, 8 * ps));
  R("brk-same", (long)sbrk(0) == (long)sbrk(0));
  // files
  char dir[] = "/tmp/census2_XXXXXX"; if (!mkdtemp(dir)) return 1; char p[300]; snprintf(p, sizeof p, "%s/f", dir);
  int fd = open(p, O_CREAT | O_RDWR | O_CLOEXEC, 0600); R("open", fd);
  struct iovec iov[2] = { { "abc", 3 }, { "defgh", 5 } }; R("writev", writev(fd, iov, 2)); R("pwritev", pwritev(fd, iov, 2, 8));
  char b1[4] = {0}, b2[6] = {0}; struct iovec riov[2] = { { b1, 3 }, { b2, 5 } }; R("preadv", preadv(fd, riov, 2, 8)); printf("rv=%s%s\n", b1, b2);
  R("dup3", dup3(fd, 99, O_CLOEXEC)); R("fd-cloexec", fcntl(99, F_GETFD) & FD_CLOEXEC); int d = fcntl(fd, F_DUPFD_CLOEXEC, 200); R("dupfd-cloexec", d); R("dupfd-fd", fcntl(d, F_GETFD) & FD_CLOEXEC);
  R("ioctl-nontty", ioctl(fd, TIOCGWINSZ, &(struct winsize){ 0 })); R("isatty", isatty(fd));
  R("fionread", ioctl(fd, FIONREAD, &(int){ 0 }));
  struct statfs sf; R("statfs", statfs(dir, &sf)); R("fstatfs", fstatfs(fd, &sf)); printf("bsize>0=%d\n", sf.f_bsize > 0);
  R("ftruncate", ftruncate(fd, 4)); R("fsync", fsync(fd)); R("fdatasync", fdatasync(fd)); R("syncfs", syncfs(fd)); sync();
  R("lseek-hole", lseek(fd, 0, SEEK_HOLE)); R("lseek-end", lseek(fd, 0, SEEK_END)); R("lseek-bad", lseek(fd, -1, SEEK_SET));
  char *dbuf = malloc(4096); int dfd = open(dir, O_RDONLY | O_DIRECTORY); R("open-dir", dfd); long n = syscall(SYS_getdents64, dfd, dbuf, 4096); R("getdents64", n > 0);
  int cnt = 0; for (long o = 0; o < n;) { struct dirent64 *e = (struct dirent64 *)(dbuf + o); if (strcmp(e->d_name, "f") == 0) printf("dent f type=%d\n", e->d_type); cnt++; o += e->d_reclen; } printf("dents=%d\n", cnt);
  R("getdents64-eof", syscall(SYS_getdents64, dfd, dbuf, 4096)); R("write-dir", write(dfd, "x", 1));
  R("faccessat", faccessat(AT_FDCWD, p, W_OK, 0)); R("access-x", access(p, X_OK)); R("mkdirat", mkdirat(dfd, "sub", 0700)); R("mkdir-exists", mkdir(p, 0700));
  R("unlinkat-dir-eisdir", unlinkat(dfd, "sub", 0)); R("unlinkat-dir", unlinkat(dfd, "sub", AT_REMOVEDIR)); R("openat-notdir", openat(fd, "x", O_RDONLY));
  R("open-enoent-dir", open("/tmp/nope/f", O_CREAT | O_RDWR, 0600)); R("open-excl", open(p, O_CREAT | O_EXCL | O_RDWR, 0600)); R("open-trunc-ro", open(p, O_RDONLY | O_TRUNC));
  R("chdir", chdir(dir)); char cwd[300]; R("getcwd", getcwd(cwd, sizeof cwd) != NULL); printf("cwd=%d\n", strcmp(cwd, dir) == 0); R("fchdir", fchdir(dfd)); R("chdir-root", chdir("/"));
  // sockets
  int sv[2]; R("socketpair", socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv));
  struct msghdr mh = { 0 }; struct iovec miov = { "hi", 2 }; char cbuf[CMSG_SPACE(sizeof(int))]; memset(cbuf, 0, sizeof cbuf);
  mh.msg_iov = &miov; mh.msg_iovlen = 1; mh.msg_control = cbuf; mh.msg_controllen = sizeof cbuf;
  struct cmsghdr *cm = CMSG_FIRSTHDR(&mh); cm->cmsg_level = SOL_SOCKET; cm->cmsg_type = SCM_RIGHTS; cm->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(cm), &fd, sizeof fd);
  R("sendmsg-rights", sendmsg(sv[0], &mh, 0));
  char rb[8] = {0}; struct iovec rv = { rb, 8 }; char rc[CMSG_SPACE(sizeof(int))]; struct msghdr rh = { 0 }; rh.msg_iov = &rv; rh.msg_iovlen = 1; rh.msg_control = rc; rh.msg_controllen = sizeof rc;
  R("recvmsg-rights", recvmsg(sv[1], &rh, 0)); struct cmsghdr *rcm = CMSG_FIRSTHDR(&rh); int rfd = -1; if (rcm && rcm->cmsg_type == SCM_RIGHTS) memcpy(&rfd, CMSG_DATA(rcm), sizeof rfd);
  printf("rb=%s rfd>2=%d\n", rb, rfd > 2); if (rfd > 2) { R("pwrite-rfd", pwrite(rfd, "xyz", 3, 0)); R("pread-rfd", pread(rfd, rb, 3, 0)); printf("via-rfd=%.3s\n", rb); }
  R("send-msg-dontwait", send(sv[0], "x", 1, MSG_DONTWAIT)); R("recv-peek", recv(sv[1], rb, 8, MSG_PEEK)); R("recv", recv(sv[1], rb, 8, 0)); R("recv-dontwait-empty", recv(sv[1], rb, 8, MSG_DONTWAIT));
  int sb = 0; socklen_t sl = sizeof sb; R("getsockopt-type", getsockopt(sv[0], SOL_SOCKET, SO_TYPE, &sb, &sl)); printf("type=%d\n", sb);
  R("getsockopt-err", getsockopt(sv[0], SOL_SOCKET, SO_ERROR, &sb, &sl)); printf("err=%d\n", sb);
  struct sockaddr_un ua; socklen_t ul = sizeof ua; R("getsockname", getsockname(sv[0], (struct sockaddr *)&ua, &ul)); printf("family=%d\n", ua.sun_family);
  R("shutdown-wr", shutdown(sv[0], SHUT_WR)); R("recv-eof", recv(sv[1], rb, 8, 0)); R("send-after-shut", send(sv[0], "x", 1, MSG_NOSIGNAL));
  int ls = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0); R("socket-inet", ls);
  R("setsockopt-reuse", setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &(int){ 1 }, sizeof(int)));
  struct sockaddr_in ia = { .sin_family = AF_INET, .sin_port = 0, .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  R("bind", bind(ls, (struct sockaddr *)&ia, sizeof ia)); socklen_t il = sizeof ia; R("getsockname-inet", getsockname(ls, (struct sockaddr *)&ia, &il)); printf("port>0=%d\n", ntohs(ia.sin_port) > 0);
  R("listen", listen(ls, 4)); int cs = socket(AF_INET, SOCK_STREAM, 0); R("connect", connect(cs, (struct sockaddr *)&ia, sizeof ia));
  int as = accept4(ls, NULL, NULL, SOCK_CLOEXEC); R("accept4", as); R("nodelay", setsockopt(cs, IPPROTO_TCP, TCP_NODELAY, &(int){ 1 }, sizeof(int)));
  R("send-inet", send(cs, "ping", 4, 0)); struct pollfd pf = { as, POLLIN, 0 }; R("ppoll", ppoll(&pf, 1, &(struct timespec){ 1, 0 }, NULL)); printf("revents=%d\n", pf.revents & POLLIN);
  R("recv-inet", recv(as, rb, 8, 0)); printf("rb=%.4s\n", rb); R("getpeername", getpeername(as, (struct sockaddr *)&ia, &il));
  R("connect-refused", connect(socket(AF_INET, SOCK_STREAM, 0), &(struct sockaddr_in){ .sin_family = AF_INET, .sin_port = htons(1), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) }, sizeof ia));
  int us = socket(AF_UNIX, SOCK_DGRAM, 0); R("socket-unix-dgram", us); struct sockaddr_un bu = { .sun_family = AF_UNIX }; snprintf(bu.sun_path, sizeof bu.sun_path, "%s/sock", dir);
  R("bind-unix", bind(us, (struct sockaddr *)&bu, sizeof bu)); struct stat sst; R("stat-sock", stat(bu.sun_path, &sst)); printf("issock=%d\n", S_ISSOCK(sst.st_mode));
  int uc = socket(AF_UNIX, SOCK_DGRAM, 0); R("sendto-unix", sendto(uc, "dg", 2, 0, (struct sockaddr *)&bu, sizeof bu)); R("recvfrom-unix", recvfrom(us, rb, 8, 0, NULL, NULL)); printf("rb=%.2s\n", rb);
  R("ppoll-timeout", ppoll(&(struct pollfd){ us, POLLIN, 0 }, 1, &(struct timespec){ 0, 1000000 }, NULL));
  R("close-bad", close(12345)); R("close", close(fd)); R("fstat-closed", fstat(fd, &sst));
  unlink(bu.sun_path); unlink(p); rmdir(dir);
  R("getdomainname", (long)0); struct rlimit rl; R("getrlimit-nofile", getrlimit(RLIMIT_NOFILE, &rl)); printf("nofile>=1024=%d\n", rl.rlim_cur >= 1024);
  R("setrlimit", setrlimit(RLIMIT_CORE, &(struct rlimit){ 0, 0 })); R("nice", nice(0) >= 0);
  puts("census2 done"); return 0;
}
