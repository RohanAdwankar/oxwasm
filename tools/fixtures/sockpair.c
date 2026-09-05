// socketpair(AF_UNIX, SOCK_STREAM): both directions, EOF after the peer
// closes, EPIPE-free write detection, poll readiness, and a child on the
// other end (what cargo's spawn error channel does).
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <poll.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/wait.h>
int main(void) {
  int sv[2];
  if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, sv) != 0) { printf("socketpair failed %d\n", errno); return 1; }
  char buf[64];
  write(sv[0], "ping", 4); int n = read(sv[1], buf, sizeof buf); buf[n] = 0; printf("a->b %d %s\n", n, buf);
  write(sv[1], "pong!", 5); n = read(sv[0], buf, sizeof buf); buf[n] = 0; printf("b->a %d %s\n", n, buf);
  struct pollfd p = { sv[0], POLLIN | POLLOUT, 0 }; poll(&p, 1, 0); printf("poll idle %d\n", p.revents);
  write(sv[1], "x", 1); p.revents = 0; poll(&p, 1, 0); printf("poll pending %d\n", p.revents & POLLIN ? 1 : 0);
  read(sv[0], buf, 1);
  pid_t pid = fork();
  if (pid == 0) { close(sv[0]); write(sv[1], "from child", 10); close(sv[1]); _exit(0); }
  close(sv[1]);
  int tot = 0; while ((n = read(sv[0], buf + tot, sizeof buf - 1 - tot)) > 0) tot += n;
  buf[tot] = 0; int st; waitpid(pid, &st, 0);
  printf("child said %d '%s' eof %d status %d\n", tot, buf, n, WEXITSTATUS(st));
  int sw[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, sw); close(sw[1]);
  n = read(sw[0], buf, 8); printf("read after peer close %d\n", n);
  fcntl(sw[0], F_SETFL, O_NONBLOCK); n = read(sw[0], buf, 8); printf("nonblock read %d\n", n);
  return 0;
}
