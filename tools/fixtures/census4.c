// census4.c - the fourth census: System V IPC, POSIX message queues, a pty
// and its ioctls, splice/tee on pipes, pipe sizes, fd flags across a fork,
// session and process-group calls, seccomp/rseq/membarrier probes, signal
// flags (SA_RESETHAND, SA_NODEFER, SA_ONSTACK, SA_NOCLDWAIT), statx fields.
// Each line name=ret/errno so native and engine compare byte for byte.
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <signal.h>
#include <termios.h>
#include <pty.h>
#include <mqueue.h>
#include <sys/ioctl.h>
#include <sys/ipc.h>
#include <sys/shm.h>
#include <sys/sem.h>
#include <sys/msg.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/syscall.h>
#include <sched.h>
#include <sys/prctl.h>
#include <linux/seccomp.h>
#include <linux/membarrier.h>
#define R(name, expr) do { errno = 0; long _r = (long)(expr); int _e = errno; printf("%s=%ld/%d\n", name, _r < 0 ? -1L : (_r > 1000000 ? 1L : _r), _r < 0 ? _e : 0); } while (0)
static volatile int hits, onalt; static char altstk[1 << 16];
static void h(int s) { (void)s; hits++; char probe; onalt = (char *)&probe >= altstk && (char *)&probe < altstk + sizeof altstk; }
static void h2(int s) { (void)s; hits++; if (hits == 1) raise(SIGUSR2); }   // SA_NODEFER: the nested raise runs the handler again inside itself
int main(void) {
  // System V shared memory, semaphores, message queues
  int shm = shmget(IPC_PRIVATE, 8192, IPC_CREAT | 0600); R("shmget", shm >= 0);
  char *m = shmat(shm, NULL, 0); R("shmat", m != (void *)-1); if (m != (void *)-1) { strcpy(m, "shared"); }
  struct shmid_ds ds; R("shmctl-stat", shmctl(shm, IPC_STAT, &ds)); printf("segsz=%d nattch=%d\n", (int)ds.shm_segsz, (int)ds.shm_nattch);
  pid_t c = fork(); if (c == 0) { char *m2 = shmat(shm, NULL, 0); int ok = m2 != (void *)-1 && strcmp(m2, "shared") == 0; if (ok) strcpy(m2, "child"); _exit(ok ? 0 : 1); }
  int st; waitpid(c, &st, 0); R("shm-child", WEXITSTATUS(st)); printf("after-child=%s\n", m != (void *)-1 ? m : "-"); R("shmdt", shmdt(m)); R("shmctl-rmid", shmctl(shm, IPC_RMID, NULL)); R("shmat-gone", shmat(shm, NULL, 0) != (void *)-1);
  int sem = semget(IPC_PRIVATE, 2, IPC_CREAT | 0600); R("semget", sem >= 0);
  union semun { int val; struct semid_ds *buf; unsigned short *array; } su = { .val = 3 }; R("semctl-setval", semctl(sem, 0, SETVAL, su)); R("semctl-getval", semctl(sem, 0, GETVAL));
  struct sembuf op = { 0, -2, 0 }; R("semop-down", semop(sem, &op, 1)); R("semctl-getval2", semctl(sem, 0, GETVAL));
  op.sem_op = -5; op.sem_flg = IPC_NOWAIT; R("semop-nowait", semop(sem, &op, 1)); op.sem_op = 1; op.sem_flg = 0; R("semop-up", semop(sem, &op, 1)); R("semctl-getval3", semctl(sem, 0, GETVAL));
  R("semctl-rmid", semctl(sem, 0, IPC_RMID)); R("semop-gone", semop(sem, &op, 1));
  int mq = msgget(IPC_PRIVATE, IPC_CREAT | 0600); R("msgget", mq >= 0); struct { long t; char b[16]; } msg = { 7, "hello" }, rcv;
  R("msgsnd", msgsnd(mq, &msg, 6, 0)); msg.t = 9; strcpy(msg.b, "nine"); R("msgsnd2", msgsnd(mq, &msg, 5, 0));
  R("msgrcv-type9", msgrcv(mq, &rcv, 16, 9, IPC_NOWAIT)); printf("got=%s type=%ld\n", rcv.b, rcv.t);
  R("msgrcv-any", msgrcv(mq, &rcv, 16, 0, IPC_NOWAIT)); printf("got=%s type=%ld\n", rcv.b, rcv.t); R("msgrcv-empty", msgrcv(mq, &rcv, 16, 0, IPC_NOWAIT));
  R("msgrcv-e2big", (msgsnd(mq, &msg, 5, 0), msgrcv(mq, &rcv, 2, 0, IPC_NOWAIT))); R("msgrcv-noerror", msgrcv(mq, &rcv, 2, 0, IPC_NOWAIT | MSG_NOERROR)); printf("trunc=%.2s\n", rcv.b);
  struct msqid_ds mds; R("msgctl-stat", msgctl(mq, IPC_STAT, &mds)); printf("qnum=%d\n", (int)mds.msg_qnum); R("msgctl-rmid", msgctl(mq, IPC_RMID, NULL));
  // POSIX message queues
  mq_unlink("/census4"); struct mq_attr at = { .mq_maxmsg = 4, .mq_msgsize = 32 }; mqd_t q = mq_open("/census4", O_CREAT | O_RDWR | O_NONBLOCK, 0600, &at); R("mq_open", q);
  R("mq_send", mq_send(q, "one", 3, 1)); R("mq_send-hi", mq_send(q, "two", 3, 5)); struct mq_attr ga; R("mq_getattr", mq_getattr(q, &ga)); printf("curmsgs=%ld maxmsg=%ld\n", ga.mq_curmsgs, ga.mq_maxmsg);
  char mb[32]; unsigned prio = 0; R("mq_receive", mq_receive(q, mb, 32, &prio)); printf("msg=%.3s prio=%u\n", mb, prio); R("mq_receive2", mq_receive(q, mb, 32, &prio)); R("mq_receive-empty", mq_receive(q, mb, 32, &prio));
  R("mq_receive-msgsize", mq_receive(q, mb, 8, &prio)); R("mq_send-toolong", mq_send(q, mb, 33, 0)); R("mq_unlink", mq_unlink("/census4")); R("mq_unlink-gone", mq_unlink("/census4")); R("mq_close", mq_close(q));
  // a pty: window size, termios, ttyname-ish, the slave as a controlling tty in a child session
  int mfd, sfd; R("openpty", openpty(&mfd, &sfd, NULL, NULL, NULL)); struct winsize ws = { 24, 80, 0, 0 }; R("TIOCSWINSZ", ioctl(sfd, TIOCSWINSZ, &ws)); struct winsize ws2; R("TIOCGWINSZ-master", ioctl(mfd, TIOCGWINSZ, &ws2)); printf("rows=%d cols=%d\n", ws2.ws_row, ws2.ws_col);
  struct termios t; R("tcgetattr", tcgetattr(sfd, &t)); printf("echo=%d icanon=%d\n", !!(t.c_lflag & ECHO), !!(t.c_lflag & ICANON)); cfmakeraw(&t); R("tcsetattr-raw", tcsetattr(sfd, TCSANOW, &t)); R("tcgetattr2", tcgetattr(sfd, &t)); printf("echo=%d\n", !!(t.c_lflag & ECHO));
  R("isatty-slave", isatty(sfd)); R("isatty-master", isatty(mfd)); R("write-master", write(mfd, "ab", 2)); char pb[8] = {0}; R("read-slave", read(sfd, pb, 8)); printf("pb=%s\n", pb);
  R("write-slave", write(sfd, "cd\n", 3)); R("read-master", read(mfd, pb, 8)); printf("pb=%.2s\n", pb);
  R("TIOCGPGRP-nosession", ioctl(sfd, TIOCGPGRP, &(int){ 0 }));
  c = fork(); if (c == 0) { int ok = setsid() > 0; ok = ok && ioctl(sfd, TIOCSCTTY, 0) == 0; int pg = 0; ok = ok && ioctl(sfd, TIOCGPGRP, &pg) == 0 && pg == getpid(); _exit(ok ? 0 : 1); }
  waitpid(c, &st, 0); R("pty-session-child", WEXITSTATUS(st)); close(sfd); close(mfd);
  // pipes: sizes, splice/tee, F_GETPIPE_SZ
  int p1[2], p2[2]; pipe(p1); pipe(p2); R("F_GETPIPE_SZ", fcntl(p1[0], F_GETPIPE_SZ)); R("F_SETPIPE_SZ", fcntl(p1[0], F_SETPIPE_SZ, 131072) >= 131072);
  write(p1[1], "tee-data", 8); R("tee", tee(p1[0], p2[1], 8, 0)); char tb[16] = {0}; R("read-teed", read(p2[0], tb, 16)); printf("tb=%s\n", tb); R("read-orig", read(p1[0], tb, 16));
  int tf = open("/tmp/census4_f", O_CREAT | O_RDWR | O_TRUNC, 0600); write(tf, "0123456789", 10); lseek(tf, 0, SEEK_SET);
  R("splice-file-pipe", splice(tf, NULL, p1[1], NULL, 10, 0)); R("splice-pipe-pipe", splice(p1[0], NULL, p2[1], NULL, 4, 0)); R("read-p2", read(p2[0], tb, 16)); printf("tb=%.4s\n", tb); R("read-p1", read(p1[0], tb, 16));
  R("splice-badfd", splice(p1[0], NULL, tf, &(loff_t){ 0 }, 0, 0)); R("vmsplice", vmsplice(p1[1], &(struct iovec){ "vm", 2 }, 1, 0)); R("read-vm", read(p1[0], tb, 16)); printf("tb=%.2s\n", tb);
  // fd flags across fork and exec: O_CLOEXEC fds vanish in the exec'd child, others survive
  int keep = open("/tmp/census4_f", O_RDONLY), gone = open("/tmp/census4_f", O_RDONLY | O_CLOEXEC); dup2(keep, 50); dup3(gone, 51, O_CLOEXEC);
  c = fork(); if (c == 0) { execl("/bin/sh", "sh", "-c", "exec 2>/dev/null; (echo x >&50) && ! (echo x >&51); exit $?", (char *)0); _exit(99); }
  waitpid(c, &st, 0); R("cloexec-across-exec", WEXITSTATUS(st)); close(keep); close(gone); close(50); close(51); unlink("/tmp/census4_f");
  // sessions and groups
  R("getpgrp", getpgrp() > 0); R("setpgid-self", setpgid(0, 0)); R("getpgid==pid", getpgid(0) == getpid()); R("setsid-leader", setsid());   // EPERM: a group leader cannot start a session
  c = fork(); if (c == 0) { pid_t s = setsid(); _exit(s == getpid() && getpgrp() == getpid() && getsid(0) == getpid() ? 0 : 1); } waitpid(c, &st, 0); R("setsid-child", WEXITSTATUS(st));
  R("setpgid-badpid", setpgid(999999, 0)); R("getpgid-badpid", getpgid(999999)); R("getsid-badpid", getsid(999999));
  // hardening probes: programs feature-test these and must get the answers Linux gives
  R("seccomp-get-mode", prctl(PR_GET_SECCOMP)); R("seccomp-badop", syscall(SYS_seccomp, 99, 0, NULL)); R("no_new_privs-get", prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0));
  R("membarrier-query", syscall(SYS_membarrier, MEMBARRIER_CMD_QUERY, 0, 0) >= 0); R("rseq-bad", syscall(SYS_rseq, NULL, 32, 0, 0)); R("unshare-0", unshare(0)); R("unshare-newuser", unshare(0x10000000) == 0 || errno == EPERM || errno == EINVAL);
  R("prctl-badopt", prctl(999999, 0, 0, 0, 0)); R("kcmp-enosys-or-einval", syscall(SYS_kcmp, getpid(), getpid(), 99, 0, 0) < 0);
  // signal flags
  hits = 0; onalt = 0; stack_t ss = { .ss_sp = altstk, .ss_size = sizeof altstk }; sigaltstack(&ss, NULL);
  struct sigaction sa = { .sa_handler = h, .sa_flags = SA_ONSTACK | SA_RESETHAND }; sigemptyset(&sa.sa_mask); R("sigaction-onstack-resethand", sigaction(SIGUSR1, &sa, NULL));
  raise(SIGUSR1); printf("hits=%d onalt=%d\n", hits, onalt); struct sigaction cur; sigaction(SIGUSR1, NULL, &cur); printf("reset-to-default=%d\n", cur.sa_handler == SIG_DFL);
  hits = 0; sa.sa_handler = h2; sa.sa_flags = SA_NODEFER; R("sigaction-nodefer", sigaction(SIGUSR2, &sa, NULL)); raise(SIGUSR2); printf("hits=%d\n", hits);
  hits = 0; sa.sa_handler = h2; sa.sa_flags = 0; sigaction(SIGUSR2, &sa, NULL); raise(SIGUSR2); printf("hits-deferred=%d\n", hits);
  struct sigaction sc = { .sa_handler = SIG_DFL, .sa_flags = SA_NOCLDWAIT }; R("sigaction-nocldwait", sigaction(SIGCHLD, &sc, NULL));
  c = fork(); if (c == 0) _exit(0); usleep(50000); R("waitpid-nocldwait", waitpid(c, &st, 0));   // the child was reaped automatically: ECHILD
  sc.sa_flags = 0; sigaction(SIGCHLD, &sc, NULL);
  // statx fields
  struct statx sx; R("statx-btime", statx(AT_FDCWD, "/tmp", AT_STATX_SYNC_AS_STAT, STATX_BTIME | STATX_INO, &sx)); printf("mask-has-ino=%d\n", !!(sx.stx_mask & STATX_INO));
  R("statx-empty-path", statx(0, "", AT_EMPTY_PATH, STATX_MODE, &sx)); R("statx-badflags", statx(AT_FDCWD, "/tmp", 0x1000000, STATX_MODE, &sx));
  puts("census4 done"); return 0;
}
