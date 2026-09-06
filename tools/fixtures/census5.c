// census5.c - the fifth census: job control and the tty line discipline.
// Stop and continue signals with WUNTRACED/WCONTINUED, a pty opened the
// posix way (grantpt/unlockpt/ptsname, TIOCGPTN), canonical editing with
// echo (the exact bytes the master sees), ^C to the foreground group, ^D as
// EOF and mid-line, VMIN in raw mode, TCFLSH, FIONREAD/TIOCOUTQ, /dev/tty
// with and without a controlling terminal, TIOCNOTTY. name=ret/errno lines.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <termios.h>
#include <poll.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#define R(name, expr) do { errno = 0; long _r = (long)(expr); int _e = errno; printf("%s=%ld/%d\n", name, _r < 0 ? -1L : (_r > 1000000 ? 1L : _r), _r < 0 ? _e : 0); } while (0)
static void hex(const char *tag, const unsigned char *b, int n) { printf("%s=", tag); for (int i = 0; i < n; i++) printf("%02x", b[i]); printf("\n"); }
static volatile int ints; static void onint(int s) { (void)s; ints++; }
static int drain(int fd, unsigned char *b, int cap) { int n = 0; struct pollfd p = { fd, POLLIN, 0 }; while (n < cap && poll(&p, 1, 200) > 0) { int r = read(fd, b + n, cap - n); if (r <= 0) break; n += r; } return n; }
// a wait that polls with WNOHANG: a state the kernel never reports shows up as
// a line rather than a hang (the first version blocked the whole sweep natively)
static pid_t waitp(pid_t c, int *st, int opts) { for (int i = 0; i < 400; i++) { pid_t r = waitpid(c, st, opts | WNOHANG); if (r != 0) return r; usleep(5000); } return -2; }
int main(void) {
  alarm(60);                                                 // a watchdog: no census hangs a sweep
  // --- stop / continue ---
  pid_t c = fork(); if (c == 0) { for (;;) pause(); }
  usleep(20000); int st = 0; R("kill-stop", kill(c, SIGSTOP)); R("waitpid-untraced", waitp(c, &st, WUNTRACED) == c); printf("stopped=%d sig=%d\n", WIFSTOPPED(st), WIFSTOPPED(st) ? WSTOPSIG(st) : -1);
  R("waitpid-nohang-while-stopped", waitpid(c, &st, WNOHANG | WUNTRACED)); R("kill-cont", kill(c, SIGCONT)); R("waitpid-continued", waitp(c, &st, WCONTINUED) == c); printf("continued=%d\n", WIFCONTINUED(st));
  kill(c, SIGKILL); waitp(c, &st, 0);                        // a fresh child for SIGTSTP: a stop sent on the heels of a continue is racy on Linux itself
  c = fork(); if (c == 0) { for (;;) pause(); } usleep(20000);
  R("kill-tstp", kill(c, SIGTSTP)); R("waitpid-untraced2", waitp(c, &st, WUNTRACED) == c); printf("stopped=%d sig=%d\n", WIFSTOPPED(st), WIFSTOPPED(st) ? WSTOPSIG(st) : -1);
  R("kill-term-stopped", kill(c, SIGTERM)); usleep(20000); R("waitpid-nohang-still-stopped", waitpid(c, &st, WNOHANG)); R("kill-cont2", kill(c, SIGCONT)); R("waitpid-exited", waitp(c, &st, 0) == c); printf("signaled=%d sig=%d\n", WIFSIGNALED(st), WTERMSIG(st));
  c = fork(); if (c == 0) { signal(SIGTSTP, SIG_IGN); for (;;) pause(); } usleep(20000);
  R("kill-tstp-ignored", kill(c, SIGTSTP)); usleep(20000); R("waitpid-nohang-not-stopped", waitpid(c, &st, WNOHANG | WUNTRACED)); kill(c, SIGKILL); waitp(c, &st, 0); printf("killed=%d\n", WTERMSIG(st));
  // --- a pty the posix way ---
  int m = posix_openpt(O_RDWR | O_NOCTTY); R("posix_openpt", m); R("grantpt", grantpt(m)); R("unlockpt", unlockpt(m)); int lock = 1; R("TIOCGPTLCK", ioctl(m, TIOCGPTLCK, &lock)); printf("locked=%d\n", lock);
  unsigned n = 99; R("TIOCGPTN", ioctl(m, TIOCGPTN, &n)); const char *sn = ptsname(m); printf("ptsname-shape=%d\n", sn && strncmp(sn, "/dev/pts/", 9) == 0 && atoi(sn + 9) == (int)n);
  int s = open(sn, O_RDWR | O_NOCTTY); R("open-slave", s >= 0); char *tn = ttyname(s); printf("ttyname-matches=%d\n", tn && strcmp(tn, sn) == 0); R("isatty", isatty(s));
  struct termios t; tcgetattr(s, &t); printf("flags echo=%d echoe=%d icanon=%d isig=%d onlcr=%d icrnl=%d\n", !!(t.c_lflag & ECHO), !!(t.c_lflag & ECHOE), !!(t.c_lflag & ICANON), !!(t.c_lflag & ISIG), !!(t.c_oflag & ONLCR), !!(t.c_iflag & ICRNL));
  printf("cc erase=%d kill=%d eof=%d intr=%d min=%d time=%d\n", t.c_cc[VERASE], t.c_cc[VKILL], t.c_cc[VEOF], t.c_cc[VINTR], t.c_cc[VMIN], t.c_cc[VTIME]);
  // canonical editing: typed text is echoed, erase echoes "\b \b", newline becomes "\r\n"
  unsigned char b[256]; R("write-typed", write(m, "abc\x7f" "d\n", 6)); R("read-line", read(s, b, sizeof b)); hex("line", b, 4); int e = drain(m, b, sizeof b); hex("echo", b, e);
  R("write-kill", write(m, "xyz\x15" "q\n", 6)); R("read-line2", read(s, b, sizeof b)); hex("line2", b, 2); e = drain(m, b, sizeof b); hex("echo2", b, e);
  R("write-cr", write(m, "cr\r", 3)); R("read-cr", read(s, b, sizeof b)); hex("cr", b, 3); e = drain(m, b, sizeof b); hex("echo-cr", b, e);
  // partial line: nothing readable until the newline (FIONREAD says 0; poll says not ready)
  R("write-partial", write(m, "par", 3)); int avail = -1; R("FIONREAD-partial", ioctl(s, FIONREAD, &avail)); printf("avail=%d\n", avail); struct pollfd pf = { s, POLLIN, 0 }; R("poll-partial", poll(&pf, 1, 50));
  R("write-eof-midline", write(m, "\x04", 1)); R("read-partial", read(s, b, sizeof b)); hex("partial", b, 3); R("write-eof-linestart", write(m, "\x04", 1)); R("read-eof", read(s, b, sizeof b)); R("read-after-eof", (write(m, "z\n", 2), read(s, b, sizeof b))); drain(m, b, sizeof b);
  // output side: ONLCR turns the slave's "\n" into "\r\n" on the master; TIOCOUTQ
  R("write-slave", write(s, "out\n", 4)); e = drain(m, b, sizeof b); hex("master-sees", b, e); int oq = -1; R("TIOCOUTQ", ioctl(s, TIOCOUTQ, &oq)); printf("outq=%d\n", oq);
  R("TCFLSH", (write(m, "junk\n", 5), usleep(20000), tcflush(s, TCIFLUSH))); avail = -1; ioctl(s, FIONREAD, &avail); printf("after-flush avail=%d\n", avail); drain(m, b, sizeof b);
  R("tcdrain", tcdrain(s)); R("tcsendbreak", tcsendbreak(s, 0));
  // raw mode: VMIN=2 makes a read wait for two bytes, no echo, no ONLCR
  struct termios r = t; cfmakeraw(&r); r.c_cc[VMIN] = 2; r.c_cc[VTIME] = 0; R("tcsetattr-raw", tcsetattr(s, TCSANOW, &r));
  R("write-one", write(m, "1", 1)); pf.fd = s; R("poll-vmin", poll(&pf, 1, 50)); R("write-two", write(m, "2", 1)); R("read-vmin", read(s, b, sizeof b)); hex("raw", b, 2); e = drain(m, b, sizeof b); printf("raw-echo-bytes=%d\n", e);
  R("write-slave-raw", write(s, "r\n", 2)); e = drain(m, b, sizeof b); hex("raw-master-sees", b, e);
  R("tcsetattr-restore", tcsetattr(s, TCSANOW, &t));
  // ^C reaches the foreground group of the pty's session; /dev/tty opens only with a controlling terminal
  R("open-dev-tty-none", open("/dev/tty", O_RDWR));   // no controlling terminal here: ENXIO
  int pp[2]; pipe(pp);
  c = fork(); if (c == 0) { setsid(); if (ioctl(s, TIOCSCTTY, 0) != 0) _exit(2); signal(SIGINT, onint); int tty = open("/dev/tty", O_RDWR); if (tty < 0) _exit(3);
    write(pp[1], "r", 1); pause(); if (ints != 1) _exit(4); if (ioctl(s, TIOCNOTTY) != 0) _exit(5); if (open("/dev/tty", O_RDWR) >= 0) _exit(6); _exit(0); }
  read(pp[0], b, 1); usleep(20000); R("write-intr", write(m, "\x03", 1)); waitpid(c, &st, 0); R("ctrl-c-child", WEXITSTATUS(st)); e = drain(m, b, sizeof b); hex("intr-echo", b, e);
  int pg = -1; R("TIOCGPGRP-after-child", ioctl(s, TIOCGPGRP, &pg)); int sid = -1; R("TIOCGSID", ioctl(s, TIOCGSID, &sid) == 0 && sid == c);
  close(s); close(m); puts("census5 done"); return 0;
}
