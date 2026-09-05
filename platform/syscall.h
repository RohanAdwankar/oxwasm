/* oxwasm platform — the M4 syscall surface, v0.
 *
 * A process is a WebAssembly module in a Web Worker. It imports exactly
 * these functions from module "ox"; the kernel (kernel.js) provides them.
 * Blocking is real: reads park the worker on Atomics.wait. The process
 * neither knows nor cares that it is running in a browser tab.
 */
#ifndef OX_SYSCALL_H
#define OX_SYSCALL_H

#define OX_STDIN  0
#define OX_STDOUT 1

__attribute__((import_module("ox"), import_name("read")))
extern int ox_read(int fd, void *buf, int len);      /* blocks; 0 = EOF */

__attribute__((import_module("ox"), import_name("write")))
extern int ox_write(int fd, const void *buf, int len);

__attribute__((import_module("ox"), import_name("exit")))
extern void ox_exit(int code);

#endif
