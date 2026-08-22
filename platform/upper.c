/* upper — classic unix filter: reads stdin, uppercases, writes stdout.
 * It blocks on read like any process anywhere. */
#include "syscall.h"

void _start(void) {
    char buf[256];
    int n;
    while ((n = ox_read(OX_STDIN, buf, sizeof buf)) > 0) {
        for (int i = 0; i < n; i++)
            if (buf[i] >= 'a' && buf[i] <= 'z') buf[i] -= 32;
        ox_write(OX_STDOUT, buf, n);
    }
    ox_exit(0);
}
