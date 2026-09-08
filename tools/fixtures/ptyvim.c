// ptyvim.c - vim on a pty (TERM=vt100, 24x80): open a file, insert a line,
// write it out, quit; the driver prints the terminal bytes it saw (escaped)
// and the file vim wrote, both compared with native.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <pty.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
static int m; static unsigned char acc[1 << 18]; static int accn;
static void show(const char *tag) { printf("%s: ", tag); for (int i = 0; i < accn; i++) { unsigned char c = acc[i]; if (c == '\n') printf("\\n"); else if (c == '\r') printf("\\r"); else if (c == 27) printf("\\e"); else if (c < 32 || c > 126) printf("\\x%02x", c); else putchar(c); } printf("\n"); accn = 0; }
// Read until the accumulated transcript contains `want`, then until the
// master reports EOF. Both are CONDITIONS, not durations.
//
// This used to settle on a quiet period - poll with a 300-400ms timeout and
// stop when nothing arrived - and it was the sweep's one flaky case: under
// emulation vim can pause longer than that between redraw chunks, so the
// transcript got cut short (413 bytes against native's 427) and the case
// failed for a reason that was not the engine. A quiet window is a margin,
// not a synchronisation, and no margin is right for every load.
static int waitfor(const char *want, int budget_ms) {
  struct pollfd p = { m, POLLIN, 0 };
  for (int waited = 0; waited < budget_ms; ) {
    int r = poll(&p, 1, 100);
    if (r < 0) return 0;
    if (r == 0) { waited += 100; continue; }
    int n = read(m, acc + accn, sizeof acc - accn - 1);
    if (n <= 0) return 0;                       // EOF: vim exited
    accn += n; acc[accn] = 0;
    if (want && memmem(acc, accn, want, strlen(want))) return 1;
  }
  return 0;
}
static void type(const char *s) { write(m, s, strlen(s)); }
int main(void) {
  alarm(300); setpgid(0, 0);
  FILE *f = fopen("/tmp/ptyvim.txt", "w"); fputs("first line\nsecond line\n", f); fclose(f);
  int s; if (openpty(&m, &s, NULL, NULL, NULL) != 0) return 1; struct winsize ws = { 24, 80, 0, 0 }; ioctl(s, TIOCSWINSZ, &ws);
  pid_t c = fork();
  if (c == 0) { setsid(); ioctl(s, TIOCSCTTY, 0); dup2(s, 0); dup2(s, 1); dup2(s, 2); close(s); close(m);
    char *env[] = { "TERM=vt100", "PATH=/usr/bin:/bin", "HOME=/root", "LANG=C", NULL };
    execle("/usr/bin/vim", "vim", "-u", "NONE", "-i", "NONE", "-n", "--not-a-term", "/tmp/ptyvim.txt", (char *)0, env); _exit(127); }
  close(s);
  // one wait for vim to have drawn the file and put the tty in raw mode, keyed
  // on the file's own text appearing rather than on a clock
  if (!waitfor("second line", 30000)) { printf("vim never drew the file\n"); return 1; }
  // then the whole keystroke sequence at once. vim consumes its typeahead in
  // order however fast it arrives, so the transcript becomes a function of the
  // INPUT rather than of when each chunk showed up - which is what makes this
  // reproducible under load.
  type("jo");  type("inserted"); type("\x1b"); type(":wq\r");
  waitfor(NULL, 60000);                         // drain to EOF
  show("session");
  int st = 0; waitpid(c, &st, 0); printf("vim exit=%d\n", WEXITSTATUS(st));
  f = fopen("/tmp/ptyvim.txt", "r"); char b[256]; printf("file: "); while (fgets(b, sizeof b, f)) { b[strcspn(b, "\n")] = 0; printf("[%s]", b); } fclose(f); printf("\n"); unlink("/tmp/ptyvim.txt"); return 0;
}
