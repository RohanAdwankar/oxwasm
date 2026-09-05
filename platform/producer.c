/* producer — writes a message to stdout, then EOF. A "program". */
#include "syscall.h"

void _start(void) {
    static const char msg[] = "hello from process 1, through a kernel pipe\n"
                       "the abstraction layer exists\n";
    ox_write(OX_STDOUT, msg, sizeof(msg) - 1);
    ox_exit(0);
}
