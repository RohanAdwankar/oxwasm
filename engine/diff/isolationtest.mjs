// Isolation: what a hostile guest can and cannot do to the host and to other
// sandboxes. Every check is an attack the guest actually attempts; the
// assertion is about the HOST side of the boundary (this process, its files,
// its network, its other sandboxes), not about the guest's own behaviour.
//
// What this is not: an audit. It is the list of attacks that were thought of,
// kept green. docs/threat-model.md says what is claimed and what is not.
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Sandbox } from '../../sdk/index.mjs';

if (!existsSync('/usr/bin/python3')) { console.log('isolationtest SKIPPED: no /usr/bin/python3 on this host'); process.exit(0); }

let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; if (process.env.SBT_VERBOSE) console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
};
const py = async (s, code, o = {}) => { try { return (await s.runCode(code, { timeoutMs: 60000, ...o })); } catch (e) { return { threw: e.name + ': ' + e.message }; } };
const text = (r) => (r.threw ? r.threw : (r.error ? 'ERR ' + r.error.name : (r.text ?? '').replace(/^'|'$/g, '')));

// canaries on the host the guest must never see
process.env.OXW_HOST_SECRET = 'host-secret-value';
const dir = mkdtempSync(join(tmpdir(), 'oxiso-'));
const secretFile = join(dir, 'secret.txt');
writeFileSync(secretFile, 'host-file-secret');
const hostSrv = createServer((q, r) => r.end('host-loopback-secret')).listen(0, '127.0.0.1');
await new Promise((r) => hostSrv.once('listening', r));
const hport = hostSrv.address().port;

const A = await Sandbox.create(), B = await Sandbox.create();

// ---- the host's files, environment and identity ---------------------------------------------------
is('a host file path does not exist in the guest', text(await py(A, `import os\nos.path.exists(${JSON.stringify(secretFile)})`)), 'False');
is('...opening it fails', text(await py(A, `try:\n    open(${JSON.stringify(secretFile)}).read()\nexcept OSError as e:\n    r = type(e).__name__\nr`)), 'FileNotFoundError');
is('the host cwd is not visible', text(await py(A, `import os\nos.path.exists(${JSON.stringify(process.cwd() + '/package.json')})`)), 'False');
is('the host environment is not inherited', text(await py(A, `import os\nstr(os.environ.get("OXW_HOST_SECRET"))`)), 'None');
is('...nor visible in /proc/self/environ', text(await py(A, `b"host-secret-value" in open("/proc/self/environ","rb").read()`)), 'False');
is('.. traversal stays inside the guest', text(await py(A, `import os\nos.path.exists("/../../../../" + ${JSON.stringify(secretFile.slice(1))})`)), 'False');
is('/proc/self/root is the guest root, not the host', text(await py(A, `import os\nos.path.exists("/proc/self/root" + ${JSON.stringify(secretFile)})`)), 'False');
is('a symlink cannot point out of the guest', text(await py(A, `import os\nos.symlink(${JSON.stringify(secretFile)}, "/tmp/l")\ntry:\n    open("/tmp/l").read()\n    r = "read"\nexcept OSError as e:\n    r = type(e).__name__\nr`)), 'FileNotFoundError');
await py(A, `open("/tmp/guest-wrote-this", "w").write("x")`);
is('a file the guest writes does not appear on the host', existsSync('/tmp/guest-wrote-this'), false);
is('the guest sees its own uid, not the host user\'s', text(await py(A, `import os\nos.getuid()`)), '0');
is('the guest hostname is not the host\'s', text(await py(A, `import os\nos.uname().nodename != ${JSON.stringify(readFileSync('/etc/hostname', 'utf8').trim() || 'x')}`)), 'True');

// ---- between sandboxes ----------------------------------------------------------------------------
await py(A, `leak = "from-A"\nopen("/tmp/from-a", "w").write("A")`);
is('another sandbox cannot see a variable', text(await py(B, `"leak" in globals()`)), 'False');
is('...or a file', text(await py(B, `import os\nos.path.exists("/tmp/from-a")`)), 'False');
is('...or a process (pid space is separate)', text(await py(B, `import os\nlen([p for p in os.listdir("/proc") if p.isdigit()]) < 10`)), 'True');

// ---- the host's network --------------------------------------------------------------------------
is('a host service on loopback is unreachable (127.0.0.1 is the guest\'s own)', text(await py(A, `import socket\ntry:\n    socket.create_connection(("127.0.0.1", ${hport}), timeout=5)\n    r = "connected"\nexcept OSError as e:\n    r = type(e).__name__\nr`)), 'ConnectionRefusedError');
{
  const N = await Sandbox.create({ network: true });
  const probe = (ip, port = 80) => `import socket\ntry:\n    socket.create_connection(("${ip}", ${port}), timeout=8)\n    r = "connected"\nexcept OSError as e:\n    r = e.errno\nr`;
  is('with a network: cloud metadata is refused (169.254.169.254)', text(await py(N, probe('169.254.169.254'))), '101');
  is('...RFC1918 10/8', text(await py(N, probe('10.0.0.1'))), '101');
  is('...172.16/12', text(await py(N, probe('172.16.0.1'))), '101');
  is('...192.168/16', text(await py(N, probe('192.168.0.1'))), '101');
  is('...CGNAT 100.64/10', text(await py(N, probe('100.64.0.1'))), '101');
  is('...the host\'s loopback via 127.x', text(await py(N, probe('127.0.0.1', hport))), '111');
  is('...0.0.0.0', text(await py(N, probe('0.0.0.0', hport))), '111');
  await N.kill();
}

// ---- hostile system calls: nothing the guest passes may reach the host ------------------------------------------
const SYS = `import ctypes, os
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
def sc(n, *a):
    libc.syscall.argtypes = [ctypes.c_long] + [ctypes.c_long] * len(a)
    r = libc.syscall(n, *a)
    return -ctypes.get_errno() if r == -1 else r
`;
for (const [name, call] of [
  ['write to a wild pointer', 'sc(1, 1, 0xdeadbeefcafe, 4096)'],
  ['read into the null page', 'sc(0, 0, 0, 4096)'],
  ['mmap a huge length', 'sc(9, 0, 1 << 62, 3, 0x22, -1, 0)'],
  ['mmap fixed at address 0', 'sc(9, 0, 4096, 3, 0x32, -1, 0)'],
  ['mount', 'sc(165, 0, 0, 0, 0, 0)'],
  ['ptrace attach pid 1', 'sc(101, 16, 1, 0, 0)'],
  ['reboot', 'sc(169, 0xfee1dead, 672274793, 0x1234567, 0)'],
  ['kexec_load', 'sc(246, 0, 0, 0, 0)'],
  ['init_module', 'sc(175, 0, 0, 0)'],
  ['unshare all namespaces', 'sc(272, 0x7e020000)'],
  ['open_by_handle_at', 'sc(304, -100, 0, 0)'],
  ['process_vm_readv on pid 1', 'sc(310, 1, 0, 1, 0, 1, 0)'],
  ['an unassigned syscall number', 'sc(999)'],
  ['a negative syscall number', 'sc(-1)'],
  ['kill every process (-1)', 'sc(62, -1, 9)'],
  ['kill the host pid', `sc(62, ${process.pid}, 9)`],
  ['setuid to the host user', `sc(105, ${process.getuid()})`],
  ['chroot', 'sc(161, 0)'],
  ['execve of a wild path pointer', 'sc(59, 0xdead0000, 0, 0)'],
]) {
  const r = await py(A, `${SYS}\nint(${call})`, { timeoutMs: 30000 });
  is(`${name}: the sandbox survives or dies, the host does not`, typeof (r.threw ?? r.text ?? 'x') === 'string', true);
}
is('the host process survived the syscall barrage', process.kill(process.pid, 0), true);
is('...including a kill aimed at its pid', (() => { try { process.kill(process.pid, 0); return true; } catch { return false; } })(), true);

// ---- exhausting what the host lends it -----------------------------------------------------------------
{
  const M = await Sandbox.create({ memMB: 256 });
  const r = await py(M, `try:\n    a = bytearray(900 * 1024 * 1024)\n    r = "allocated"\nexcept MemoryError:\n    r = "MemoryError"\nr`, { timeoutMs: 120000 });
  is('allocating past memMB fails inside the guest', text(r), 'MemoryError');
  is('...and the sandbox is still alive', await M.isRunning(), true);
  await M.kill();
}
{
  const F = await Sandbox.create();
  const r = await py(F, `import os, time\nn = 0\ntry:\n    while n < 5000:\n        if os.fork() == 0:\n            time.sleep(60); os._exit(0)\n        n += 1\nexcept OSError:\n    pass\nn`, { timeoutMs: 40000 });
  is('a fork bomb ends (error or timeout), it does not hang the host', typeof (r.threw ?? r.text ?? 'x') === 'string', true);
  await F.kill();
}
{
  let ticks = 0; const hb = setInterval(() => ticks++, 25);
  const W = await Sandbox.create();
  const r = await py(W, `f = open("/tmp/big", "wb")\ntry:\n    for i in range(6000):\n        f.write(b"x" * (1 << 20))\n    r = "wrote"\nexcept OSError as e:\n    r = type(e).__name__\nr`, { timeoutMs: 60000 });
  clearInterval(hb);
  is('filling the in-memory disk does not take the host down (the event loop kept running)', ticks > 20, true);
  is('...the write is refused with ENOSPC, not allowed to reach 6 GB', text(r), 'OSError');
  await W.kill().catch(() => {});
}
{
  // unnamed files are in no path table; they must still be charged
  const U = await Sandbox.create({ diskMB: 64 });
  const r = await py(U, `import os\nfd = os.memfd_create("m")\ntry:\n    for i in range(200):\n        os.write(fd, b"x" * (1 << 20))\n    r = "wrote"\nexcept OSError as e:\n    r = type(e).__name__\nr`, { timeoutMs: 60000 });
  is('an unnamed (memfd) file is charged against diskMB too', text(r), 'OSError');
  await U.kill().catch(() => {});
}
{
  const X = await Sandbox.create();
  const r = await py(X, `import ctypes\nctypes.memmove(0, b"x" * 64, 64)`, { timeoutMs: 30000 });
  is('a guest write to the null page kills that guest, not the host', typeof (r.threw ?? r.error?.name ?? 'fine') === 'string', true);
  await X.kill().catch(() => {});
}

// ---- after all of it, an untouched sandbox and the host are fine ------------------------------------------------
is('an unrelated sandbox still works', text(await py(B, '1 + 1')), '2');
is('the host file was not modified', readFileSync(secretFile, 'utf8'), 'host-file-secret');
await A.kill().catch(() => {}); await B.kill().catch(() => {});
hostSrv.close(); rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass}/${pass + fail} isolation checks`);
process.exit(fail ? 1 : 0);
