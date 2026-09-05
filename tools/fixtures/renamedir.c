// rename(2) on directories: the tree moves, an empty directory moves, a
// directory cannot replace a file, renameat2 NOREPLACE refuses an existing
// target (rustc finalises its incremental session directory this way).
#include <stdio.h>
#include <fcntl.h>
#include <errno.h>
#include <unistd.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
static void put(const char *p, const char *s) { int fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0644); write(fd, s, strlen(s)); close(fd); }
static void show(const char *p) { char b[64]; int fd = open(p, O_RDONLY); int n = fd < 0 ? -1 : (int)read(fd, b, 63); if (n >= 0) b[n] = 0; printf("%s: %s\n", p, fd < 0 ? "missing" : b); if (fd >= 0) close(fd); }
static void clean(void) {   // idempotent: native runs leave the tree behind
  unlink("/tmp/rd_final/c.txt"); unlink("/tmp/rd_final/a.txt"); unlink("/tmp/rd_final/sub/b.txt"); unlink("/tmp/rd_final/l");
  rmdir("/tmp/rd_final/sub"); rmdir("/tmp/rd_final/empty"); rmdir("/tmp/rd_final");
  unlink("/tmp/rd_work/a.txt"); unlink("/tmp/rd_work/sub/b.txt"); unlink("/tmp/rd_work/l");
  rmdir("/tmp/rd_work/sub"); rmdir("/tmp/rd_work/empty"); rmdir("/tmp/rd_work"); unlink("/tmp/rd_file");
}
int main(void) {
  clean();
  mkdir("/tmp/rd_work", 0755); mkdir("/tmp/rd_work/sub", 0755); mkdir("/tmp/rd_work/empty", 0755);
  put("/tmp/rd_work/a.txt", "alpha"); put("/tmp/rd_work/sub/b.txt", "beta"); symlink("a.txt", "/tmp/rd_work/l");
  printf("rename dir %d\n", rename("/tmp/rd_work", "/tmp/rd_final"));
  show("/tmp/rd_final/a.txt"); show("/tmp/rd_final/sub/b.txt"); show("/tmp/rd_final/l"); show("/tmp/rd_work/a.txt");
  struct stat st; printf("empty moved %d, old gone %d\n", stat("/tmp/rd_final/empty", &st) == 0, stat("/tmp/rd_work", &st) != 0);
  put("/tmp/rd_file", "f");
  printf("dir over file %d\n", rename("/tmp/rd_final", "/tmp/rd_file") == 0 ? 0 : errno);
  printf("into itself %d\n", rename("/tmp/rd_final", "/tmp/rd_final/sub/x") == 0 ? 0 : errno);
  printf("noreplace %d\n", syscall(SYS_renameat2, AT_FDCWD, "/tmp/rd_final/a.txt", AT_FDCWD, "/tmp/rd_file", 1) == 0 ? 0 : errno);
  printf("file rename %d\n", rename("/tmp/rd_final/a.txt", "/tmp/rd_final/c.txt")); show("/tmp/rd_final/c.txt");
  clean();
  return 0;
}
