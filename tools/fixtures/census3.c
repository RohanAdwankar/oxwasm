// census3.c - the third census: filesystem edge cases, /proc, timers,
// threads. Each line name=ret/errno (and a few derived values) so native
// and engine compare byte for byte. What the first two left out: ELOOP,
// ENAMETOOLONG, ENOTEMPTY, hard link counts, O_APPEND with pwrite,
// O_PATH, dup2 onto itself, truncate, lstat/readlink forms, mkfifo via
// mknod, F_OFD locks, timer_create/settime, clock_nanosleep ABSTIME,
// sigsuspend, sigwaitinfo, epoll edge-triggered and oneshot, poll on a
// regular file, /proc/self/{cwd,exe,fd,cmdline,status,stat,maps} shapes,
// uname fields, gethostname, threads with pthread + set_tid_address.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <pthread.h>
#include <time.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/epoll.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <sys/mman.h>
#define R(name, expr) do { errno = 0; long _r = (long)(expr); int _e = errno; printf("%s=%ld/%d\n", name, _r < 0 ? -1L : (_r > 1000000 ? 1L : _r), _r < 0 ? _e : 0); } while (0)
static volatile int hits; static void h(int s) { (void)s; hits++; }
static void *thr(void *a) { *(int *)a = syscall(SYS_gettid) != getpid(); return (void *)42; }
int main(void) {
  char dir[] = "/tmp/census3_XXXXXX"; if (!mkdtemp(dir)) return 1; char p[400], q[400], l[400];
  snprintf(p, sizeof p, "%s/f", dir); snprintf(q, sizeof q, "%s/g", dir); snprintf(l, sizeof l, "%s/l", dir);
  // files, links, names
  int fd = open(p, O_CREAT | O_RDWR, 0644); R("open", fd); R("write", write(fd, "hello", 5));
  R("link", link(p, q)); struct stat st; R("stat", stat(p, &st)); printf("nlink=%d size=%d\n", (int)st.st_nlink, (int)st.st_size);
  R("unlink-g", unlink(q)); stat(p, &st); printf("nlink=%d\n", (int)st.st_nlink);
  R("symlink", symlink("f", l)); R("lstat", lstat(l, &st)); printf("islnk=%d lsize=%d\n", S_ISLNK(st.st_mode), (int)st.st_size);
  R("stat-via-link", stat(l, &st)); printf("size=%d\n", (int)st.st_size);
  char rb[400]; R("readlink", readlink(l, rb, sizeof rb)); printf("target=%.*s\n", 1, rb);
  R("readlink-notlink", readlink(p, rb, sizeof rb)); R("readlink-enoent", readlink(q, rb, sizeof rb));
  snprintf(rb, sizeof rb, "%s/loop", dir); R("symlink-loop", symlink(rb, rb)); R("open-eloop", open(rb, O_RDONLY)); R("stat-eloop", stat(rb, &st)); R("lstat-loop", lstat(rb, &st));
  char longn[5000]; memset(longn, 'a', sizeof longn - 1); longn[sizeof longn - 1] = 0; R("open-enametoolong", open(longn, O_RDONLY)); R("stat-enametoolong", stat(longn, &st));
  snprintf(rb, sizeof rb, "%s/d", dir); R("mkdir", mkdir(rb, 0700)); snprintf(rb + strlen(rb), 100, "/x"); R("touch-in-d", close(open(rb, O_CREAT | O_WRONLY, 0600)));
  snprintf(rb, sizeof rb, "%s/d", dir); R("rmdir-notempty", rmdir(rb)); R("rename-over-notempty", rename(p, rb)); R("rename-dir-over-file", rename(rb, p));
  R("unlink-dir", unlink(rb)); snprintf(rb, sizeof rb, "%s/d/x", dir); R("unlink-x", unlink(rb)); snprintf(rb, sizeof rb, "%s/d", dir); R("rmdir", rmdir(rb)); R("rmdir-enoent", rmdir(rb));
  R("mkdir-eexist-file", mkdir(p, 0700)); R("chdir-notdir", chdir(p)); R("mkdir-enoent-parent", mkdir("/tmp/nope/d", 0700));
  R("truncate", truncate(p, 2)); stat(p, &st); printf("size=%d\n", (int)st.st_size); R("truncate-enoent", truncate(q, 0));
  int afd = open(p, O_WRONLY | O_APPEND); R("open-append", afd); R("pwrite-append", pwrite(afd, "AB", 2, 0)); R("write-append", write(afd, "CD", 2)); stat(p, &st); printf("size=%d\n", (int)st.st_size);
  R("lseek-append", lseek(afd, 0, SEEK_CUR)); close(afd);
  int pfd = open(p, O_PATH); R("open-opath", pfd); R("read-opath", read(pfd, rb, 1)); R("fstat-opath", fstat(pfd, &st)); printf("size=%d\n", (int)st.st_size); close(pfd);
  R("dup2-self", dup2(fd, fd)); R("dup2-bad", dup2(fd, -1)); R("dup-closed", dup(999));
  snprintf(rb, sizeof rb, "%s/fifo", dir); R("mknod-fifo", mknod(rb, S_IFIFO | 0600, 0)); stat(rb, &st); printf("isfifo=%d\n", S_ISFIFO(st.st_mode)); R("mknod-eexist", mknod(rb, S_IFIFO | 0600, 0)); unlink(rb);
  R("umask-child", ({ pid_t c = fork(); if (c == 0) { umask(077); _exit(0); } int s; waitpid(c, &s, 0); (long)umask(022); }));   // the child's umask does not leak back
  R("chdir-child", ({ pid_t c = fork(); if (c == 0) { chdir("/tmp"); _exit(0); } int s; waitpid(c, &s, 0); (long)(getcwd(rb, sizeof rb) && strcmp(rb, dir) != 0 && rb[0] == '/'); }));
  R("faccessat-eaccess", faccessat(AT_FDCWD, p, X_OK, AT_EACCESS));
  struct flock fl = { .l_type = F_WRLCK, .l_whence = SEEK_SET, .l_start = 0, .l_len = 1 };
  R("ofd-setlk", fcntl(fd, F_OFD_SETLK, &fl)); int fd2 = open(p, O_RDWR); struct flock fl2 = fl; R("ofd-setlk-conflict", fcntl(fd2, F_OFD_SETLK, &fl2));
  fl2.l_type = F_WRLCK; R("ofd-getlk", fcntl(fd2, F_OFD_GETLK, &fl2)); printf("getlk-type=%d\n", fl2.l_type == F_WRLCK); fl.l_type = F_UNLCK; R("ofd-unlck", fcntl(fd, F_OFD_SETLK, &fl)); close(fd2);
  // poll/epoll shapes
  struct pollfd pf = { fd, POLLIN | POLLOUT, 0 }; R("poll-file", poll(&pf, 1, 0)); printf("revents=%d\n", pf.revents == (POLLIN | POLLOUT));
  int dfd = open(dir, O_RDONLY | O_DIRECTORY); pf.fd = dfd; pf.events = POLLIN; R("poll-dir", poll(&pf, 1, 0)); printf("revents=%d\n", pf.revents);
  pf.fd = 12345; R("poll-badfd", poll(&pf, 1, 0)); printf("revents-nval=%d\n", pf.revents == POLLNVAL);
  int pp[2]; pipe2(pp, O_NONBLOCK); int ep = epoll_create1(0); struct epoll_event ev = { .events = EPOLLIN | EPOLLET, .data.u32 = 1 };
  R("epoll-add-et", epoll_ctl(ep, EPOLL_CTL_ADD, pp[0], &ev)); R("epoll-add-dup", epoll_ctl(ep, EPOLL_CTL_ADD, pp[0], &ev)); R("epoll-mod-missing", epoll_ctl(ep, EPOLL_CTL_MOD, pp[1], &ev));
  write(pp[1], "x", 1); struct epoll_event out[4]; R("epoll-wait-et", epoll_wait(ep, out, 4, 0)); R("epoll-wait-et-again", epoll_wait(ep, out, 4, 0));
  write(pp[1], "y", 1); R("epoll-wait-et-newdata", epoll_wait(ep, out, 4, 0));
  ev.events = EPOLLIN | EPOLLONESHOT; R("epoll-mod-oneshot", epoll_ctl(ep, EPOLL_CTL_MOD, pp[0], &ev)); R("epoll-wait-oneshot", epoll_wait(ep, out, 4, 0)); R("epoll-wait-oneshot-again", epoll_wait(ep, out, 4, 0));
  R("epoll-del", epoll_ctl(ep, EPOLL_CTL_DEL, pp[0], NULL)); R("epoll-del-again", epoll_ctl(ep, EPOLL_CTL_DEL, pp[0], NULL)); R("epoll-add-file", epoll_ctl(ep, EPOLL_CTL_ADD, fd, &ev));
  R("epoll-add-self", epoll_ctl(ep, EPOLL_CTL_ADD, ep, &ev));
  // timers and sleeps
  timer_t tm; struct sigevent se = { .sigev_notify = SIGEV_SIGNAL, .sigev_signo = SIGALRM }; signal(SIGALRM, h);
  sigset_t blk, old; sigemptyset(&blk); sigaddset(&blk, SIGALRM); sigprocmask(SIG_BLOCK, &blk, &old);   // blocked before arming: the expiry must wait for sigtimedwait
  R("timer_create", timer_create(CLOCK_MONOTONIC, &se, &tm)); struct itimerspec its = { { 0, 0 }, { 0, 300000000 } };   /* 300 ms: still armed at the next call on a loaded engine */
  R("timer_settime", timer_settime(tm, 0, &its, NULL)); struct itimerspec cur; R("timer_gettime", timer_gettime(tm, &cur)); printf("armed=%d\n", cur.it_value.tv_sec == 0 && cur.it_value.tv_nsec > 0);
  siginfo_t si; struct timespec to = { 10, 0 }; R("sigtimedwait-timer", sigtimedwait(&blk, &si, &to)); printf("si_code=%d overrun=%d\n", si.si_code == SI_TIMER, timer_getoverrun(tm));
  sigprocmask(SIG_SETMASK, &old, NULL); R("timer_delete", timer_delete(tm)); R("timer_delete-again", timer_delete(tm));
  struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now); now.tv_nsec += 1000000; if (now.tv_nsec >= 1000000000) { now.tv_sec++; now.tv_nsec -= 1000000000; }
  R("clock_nanosleep-abs", clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &now, NULL)); R("clock_nanosleep-badclock", clock_nanosleep(99, 0, &(struct timespec){ 0, 1 }, NULL));
  R("nanosleep-einval", nanosleep(&(struct timespec){ 0, -1 }, NULL)); R("alarm", alarm(0));
  // signals: sigsuspend wakes on a handled signal, sigwaitinfo takes a pending one
  hits = 0; signal(SIGUSR1, h); sigemptyset(&blk); sigaddset(&blk, SIGUSR1); sigprocmask(SIG_BLOCK, &blk, &old); raise(SIGUSR1);
  sigset_t none; sigemptyset(&none); R("sigsuspend", sigsuspend(&none)); printf("hits=%d\n", hits);
  raise(SIGUSR1); R("sigwaitinfo", sigwaitinfo(&blk, &si)); printf("hits=%d signo=%d\n", hits, si.si_signo); sigprocmask(SIG_SETMASK, &old, NULL);
  struct sigaction sa; R("sigaction-get", sigaction(SIGUSR1, NULL, &sa)); printf("handler-set=%d\n", sa.sa_handler == h); R("sigaction-bad", sigaction(SIGKILL, &sa, NULL)); R("sigaction-0", sigaction(0, NULL, &sa));
  // /proc shapes
  R("readlink-cwd", ({ long n = readlink("/proc/self/cwd", rb, sizeof rb - 1); if (n > 0) rb[n] = 0; n > 0 && rb[0] == '/'; }));
  R("readlink-exe", ({ long n = readlink("/proc/self/exe", rb, sizeof rb - 1); if (n > 0) rb[n] = 0; n > 0 && strstr(rb, "census3") != NULL; }));
  snprintf(rb, sizeof rb, "/proc/self/fd/%d", fd); char tb[400]; R("readlink-fd", ({ long n = readlink(rb, tb, sizeof tb - 1); if (n > 0) tb[n] = 0; n > 0 && strcmp(tb, p) == 0; }));
  R("readlink-fd-bad", readlink("/proc/self/fd/12345", tb, sizeof tb));
  FILE *f = fopen("/proc/self/cmdline", "r"); char cl[400] = {0}; size_t n = f ? fread(cl, 1, sizeof cl - 1, f) : 0; if (f) fclose(f); R("cmdline", n > 0 && strstr(cl, "census3") != NULL && cl[n - 1] == 0);
  f = fopen("/proc/self/status", "r"); int sawpid = 0, sawtgid = 0, sawstate = 0; if (f) { while (fgets(rb, sizeof rb, f)) { if (!strncmp(rb, "Pid:", 4)) sawpid = atoi(rb + 4) == getpid(); if (!strncmp(rb, "Tgid:", 5)) sawtgid = 1; if (!strncmp(rb, "State:", 6)) sawstate = strstr(rb, "R") != NULL; } fclose(f); }
  printf("status pid=%d tgid=%d state=%d\n", sawpid, sawtgid, sawstate);
  f = fopen("/proc/self/stat", "r"); int spid = 0; char comm[64] = {0}; char state = 0; long ppid = -1; if (f) { if (fscanf(f, "%d (%63[^)]) %c %ld", &spid, comm, &state, &ppid) == 4) printf("stat pid=%d comm=%s state=%c ppid=%d\n", spid == getpid(), comm, state, ppid == getppid()); fclose(f); }
  f = fopen("/proc/self/maps", "r"); int lines = 0, sawstack = 0, sawexe = 0; if (f) { while (fgets(rb, sizeof rb, f)) { lines++; if (strstr(rb, "[stack]")) sawstack = 1; if (strstr(rb, "census3")) sawexe = 1; } fclose(f); }
  printf("maps lines>3=%d stack=%d exe=%d\n", lines > 3, sawstack, sawexe);
  f = fopen("/proc/self/limits", "r"); int sawnofile = 0; if (f) { while (fgets(rb, sizeof rb, f)) if (strstr(rb, "open files")) sawnofile = 1; fclose(f); } printf("limits nofile=%d\n", sawnofile);
  f = fopen("/proc/meminfo", "r"); long memtotal = 0; if (f) { while (fgets(rb, sizeof rb, f)) if (sscanf(rb, "MemTotal: %ld", &memtotal) == 1) break; fclose(f); } printf("meminfo total>0=%d\n", memtotal > 0);
  f = fopen("/proc/cpuinfo", "r"); int sawproc = 0; if (f) { while (fgets(rb, sizeof rb, f)) if (!strncmp(rb, "processor", 9)) sawproc++; fclose(f); } printf("cpuinfo processors>0=%d\n", sawproc > 0);
  f = fopen("/proc/sys/kernel/osrelease", "r"); int sawrel = 0; if (f) { sawrel = fgets(rb, sizeof rb, f) && strchr(rb, '.') != NULL; fclose(f); } printf("osrelease=%d\n", sawrel);
  f = fopen("/proc/sys/kernel/pid_max", "r"); long pm = 0; if (f) { if (fscanf(f, "%ld", &pm) != 1) pm = 0; fclose(f); } printf("pid_max>=32768=%d\n", pm >= 32768);
  f = fopen("/proc/self/mountinfo", "r"); int sawroot = 0; if (f) { while (fgets(rb, sizeof rb, f)) if (strstr(rb, " / ")) sawroot = 1; fclose(f); } printf("mountinfo root=%d\n", sawroot);
  struct utsname u; R("uname", uname(&u)); printf("sysname=%s machine=%s release-dots=%d nodename-len>0=%d\n", u.sysname, u.machine, strchr(u.release, '.') != NULL, (int)(strlen(u.nodename) > 0));
  R("gethostname", ({ long r = gethostname(rb, sizeof rb); r == 0 && strcmp(rb, u.nodename) == 0; }));
  R("sysconf-nproc", sysconf(_SC_NPROCESSORS_ONLN) >= 1); R("sysconf-pagesize", sysconf(_SC_PAGESIZE)); R("sysconf-clk", sysconf(_SC_CLK_TCK)); R("sysconf-openmax", sysconf(_SC_OPEN_MAX) >= 1024);
  // threads
  int tidok = -1; pthread_t t; R("pthread_create", pthread_create(&t, NULL, thr, &tidok)); void *rv; R("pthread_join", pthread_join(t, &rv)); printf("tid!=pid=%d rv=%ld\n", tidok, (long)rv);
  R("gettid==pid", syscall(SYS_gettid) == getpid()); R("set_tid_address", syscall(SYS_set_tid_address, &tidok) == getpid());
  R("sched_getscheduler", sched_getscheduler(0)); struct sched_param spm = { 0 }; R("sched_setscheduler", sched_setscheduler(0, SCHED_OTHER, &spm)); R("sched_getparam", sched_getparam(0, &spm));
  R("sched_get_priority_max", sched_get_priority_max(SCHED_FIFO)); R("sched_rr_get_interval", sched_rr_get_interval(0, &now) == 0);
  close(fd); close(dfd); unlink(p); unlink(l); snprintf(rb, sizeof rb, "%s/loop", dir); unlink(rb); rmdir(dir);
  puts("census3 done"); return 0;
}
