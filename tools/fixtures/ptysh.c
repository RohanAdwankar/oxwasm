// ptysh.c - an interactive bash on a pty, driven like a terminal would: the
// driver types commands and control characters on the master and prints
// what the terminal would show, so job control (a background job, jobs,
// kill %1, ^C to a foreground cat, ^Z stopping sleep, fg continuing it) and
// the line discipline are compared with native byte for byte. Job pids vary
// between runs, so "[1] 12345" is printed as "[1] PID".
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <poll.h>
#include <pty.h>
#include <ctype.h>
#include <sys/wait.h>
#include <sys/ioctl.h>
static int m;
static char acc[65536]; static int accn;
static void show(const char *tag) {       // print the accumulated terminal bytes, escaped, pids normalised
  printf("%s: ", tag);
  for (int i = 0; i < accn; i++) { unsigned char c = acc[i];
    if (c == '[' && i + 3 < accn && isdigit(acc[i + 1]) && acc[i + 2] == ']' && (acc[i + 3] == ' ' || acc[i + 3] == '+' || acc[i + 3] == '-')) {   // "[1] 12345" / "[1]+ 12345"
      int j = i + 3; while (j < accn && (acc[j] == ' ' || acc[j] == '+' || acc[j] == '-')) j++;
      if (j < accn && isdigit(acc[j])) { printf("[%c]%.*sPID", acc[i + 1], j - i - 3, acc + i + 3); while (j < accn && isdigit(acc[j])) j++; i = j - 1; continue; } }
    if (c == '\n') printf("\\n"); else if (c == '\r') printf("\\r"); else if (c < 32 || c > 126) printf("\\x%02x", c); else putchar(c); }
  printf("\n"); accn = 0;
}
static int until_prompt(int ms) {        // read the master until the prompt "$ " ends the buffer (or a quiet spell)
  struct pollfd p = { m, POLLIN, 0 }; int quiet = 0;
  for (int i = 0; i < 400; i++) {
    if (accn >= 2 && acc[accn - 2] == '$' && acc[accn - 1] == ' ') { if (poll(&p, 1, 60) <= 0) return 1; }   // a prompt, and nothing more for 60 ms
    if (poll(&p, 1, ms) <= 0) { if (++quiet > 3) return 0; continue; }
    int n = read(m, acc + accn, sizeof acc - accn - 1); if (n <= 0) return 0; accn += n; }
  return 0;
}
static void type(const char *s) { write(m, s, strlen(s)); }
int main(void) {
  alarm(60); setpgid(0, 0);
  int s; if (openpty(&m, &s, NULL, NULL, NULL) != 0) return 1;
  struct winsize ws = { 24, 80, 0, 0 }; ioctl(s, TIOCSWINSZ, &ws);
  pid_t c = fork();
  if (c == 0) { setsid(); ioctl(s, TIOCSCTTY, 0); dup2(s, 0); dup2(s, 1); dup2(s, 2); close(s); close(m);
    char *env[] = { "PS1=$ ", "PS2=> ", "TERM=dumb", "PATH=/usr/bin:/bin", "HOME=/root", "LANG=C", NULL };
    execle("/bin/bash", "bash", "--norc", "--noprofile", "-i", (char *)0, env); _exit(127); }
  close(s);
  until_prompt(300); show("start");
  type("echo hello\n"); until_prompt(300); show("echo");
  type("sleep 30 &\n"); until_prompt(300); show("bg");
  type("jobs\n"); until_prompt(300); show("jobs");
  type("kill %1\n"); until_prompt(300); show("kill");
  type("echo after\n"); until_prompt(300); show("after");          // the job's death is reported before this prompt
  type("cat\n"); usleep(200000); type("abc\n"); usleep(200000); type("\x03"); until_prompt(300); show("cat-intr");
  type("sleep 100\n"); usleep(300000); type("\x1a"); until_prompt(300); show("susp");
  type("jobs\n"); until_prompt(300); show("jobs2");
  type("fg\n"); usleep(300000); type("\x03"); until_prompt(300); show("fg-intr");
  type("echo $?\n"); until_prompt(300); show("status");
  type("exit\n"); usleep(200000); until_prompt(200); show("exit");
  int st = 0; waitpid(c, &st, 0); printf("bash exit=%d\n", WEXITSTATUS(st)); return 0;
}
