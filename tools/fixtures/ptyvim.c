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
static void settle(int quiet_ms) { struct pollfd p = { m, POLLIN, 0 }; for (int i = 0; i < 200; i++) { if (poll(&p, 1, quiet_ms) <= 0) return; int n = read(m, acc + accn, sizeof acc - accn - 1); if (n <= 0) return; accn += n; } }
static void type(const char *s) { write(m, s, strlen(s)); }
int main(void) {
  alarm(60); setpgid(0, 0);
  FILE *f = fopen("/tmp/ptyvim.txt", "w"); fputs("first line\nsecond line\n", f); fclose(f);
  int s; if (openpty(&m, &s, NULL, NULL, NULL) != 0) return 1; struct winsize ws = { 24, 80, 0, 0 }; ioctl(s, TIOCSWINSZ, &ws);
  pid_t c = fork();
  if (c == 0) { setsid(); ioctl(s, TIOCSCTTY, 0); dup2(s, 0); dup2(s, 1); dup2(s, 2); close(s); close(m);
    char *env[] = { "TERM=vt100", "PATH=/usr/bin:/bin", "HOME=/root", "LANG=C", NULL };
    execle("/usr/bin/vim", "vim", "-u", "NONE", "-i", "NONE", "-n", "--not-a-term", "/tmp/ptyvim.txt", (char *)0, env); _exit(127); }
  close(s);
  settle(400); show("start");
  type("jo"); settle(300); type("inserted"); settle(300); type("\x1b"); settle(400); show("insert");
  type(":wq\r"); settle(400); show("wq");
  int st = 0; waitpid(c, &st, 0); printf("vim exit=%d\n", WEXITSTATUS(st));
  f = fopen("/tmp/ptyvim.txt", "r"); char b[256]; printf("file: "); while (fgets(b, sizeof b, f)) { b[strcspn(b, "\n")] = 0; printf("[%s]", b); } fclose(f); printf("\n"); unlink("/tmp/ptyvim.txt"); return 0;
}
