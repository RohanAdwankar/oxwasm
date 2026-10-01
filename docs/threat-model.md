# Threat model

What oxwasm claims about running untrusted code, what it does not, and how
each claim is tested. `node engine/diff/isolationtest.mjs` runs every attack
listed here; it is in CI and must stay green.

This is a statement by the authors, not an independent audit. No third party
has reviewed this code.

## The boundary

Each sandbox is one worker thread in your Node process. Inside it, the guest's
x86-64 instructions are interpreted or compiled to WebAssembly and run in a
Wasm linear memory. The guest has no instruction that reaches the host. Its only
way out is a system call, and every system call is a JavaScript function in
`engine/linux.mjs` that operates on the engine's own data structures: an
in-memory filesystem, in-memory pipes, and, only when you ask for it, the
network bridge in `sdk/net.mjs`.

So the claims below are claims about those handlers, not about a kernel.

## What is claimed

| Claim | How it holds | Test |
|---|---|---|
| The guest cannot read or write host files | The filesystem is a map of paths to byte arrays built from the image; there is no path that resolves to the host | host path, `..`, `/proc/self/root`, symlink, and write-back checks |
| The guest cannot see host environment variables | The guest environment is built from scratch | `os.environ`, `/proc/self/environ` |
| One sandbox cannot see another | Separate worker threads, separate engines, separate file maps | variable, file, and pid-space checks |
| The guest cannot use the host's network unless asked | No socket reaches the host without `network` set | connect with network off |
| With `network` on, the guest cannot reach the host's private space by default | `sdk/net.mjs` refuses RFC1918, link-local (cloud metadata), CGNAT, documentation, multicast and loopback ranges unless `allowPrivate`/`allow` says otherwise | metadata, 10/8, 172.16/12, 192.168/16, 100.64/10, 127.x, 0.0.0.0 |
| The guest's `127.0.0.1` is its own | Loopback connects are answered inside the engine | host service on loopback is unreachable |
| A guest cannot spend unbounded host memory | RAM is capped by `memMB`; file writes by any process in the guest, and unnamed files (memfd, O_TMPFILE), are charged against `diskMB` (default 1024) and refused with ENOSPC | allocation past `memMB`, a 6 GB write, the same write from a spawned process, a memfd |
| A guest that never yields cannot hang the host | The sandbox runs in a worker thread that the parent terminates on timeout | busy-loop containment in `sandboxtest.mjs` |
| Hostile system calls do not affect the host | Handlers take guest pointers through bounds-checked guest-memory accessors | 19 syscalls with wild pointers and dangerous numbers |
| A fork bomb is contained | It ends in an error or a timeout; the host is unaffected | fork-bomb check |
| With `isolation: 'process'`, an engine bug that gives a guest JavaScript execution still cannot read host files outside a short allow-list, write outside the cache and directories you name, or start a process | The sandbox runs in a child process under Node's `--permission` model, with no child-process permission | a self-test run inside that process: reads of `/etc/passwd`, `/proc/self/environ` and `$HOME`, a write to `/tmp`, and a spawn are all denied (needs `OXWASM_TEST_ROOTFS`) |

## What is not claimed

- **Not a defense against engine bugs.** A memory-safety or logic bug in the
  engine's syscall handlers or in the Wasm code generator is the realistic way
  out. JavaScript and Wasm make the classic memory-corruption routes hard, but
  the engine is about 14,000 lines (5,300 of them syscall handlers), differentially tested against hardware
  for correctness, not for security. If you run hostile code, use
  `isolation: 'process'` (below) and also run the host with OS-level
  confinement (a container, a low-privilege user).
- **`isolation: 'process'` is not a sandbox on its own.** It narrows what an
  escaped guest can reach (files, new processes). Node 22's permission model
  does not restrict the network or the process's memory and CPU, and an escaped
  guest keeps whatever the allow-list grants: the cache directory, the rootfs
  image, and the directories named in `allowWrite`. It needs a rootfs image,
  because assembling the host-borrowed Python image runs host tools.
- **Not a side-channel defense.** Timing, cache and speculative-execution
  channels are not addressed. The guest can read the clock.
- **Not CPU fairness.** A busy sandbox uses one core until it times out. Many
  busy sandboxes use many cores. Set `timeoutMs` and limit concurrency.
- **Network, when enabled, is real network.** The guest can send arbitrary TCP
  and UDP to public addresses: scanning, abuse, exfiltration of anything it was
  given. Use `allow`/`deny`, or leave `network` off. DNS to the host's resolvers
  is always permitted when the network is on.
- **No enforcement of users and permissions inside the guest.** Credentials
  are tracked so programs behave, but file access does not consult them. The
  guest is root in its own world, and that world is the only thing it owns.
- **The disk quota is approximate.** It counts bytes written by the guest to
  files; it does not account for every in-engine structure (pipe buffers,
  the path table) and a guest that creates millions of tiny files spends memory
  beyond `diskMB`.
- **`getHost` opens a host port.** It listens on 127.0.0.1 unless told
  otherwise and does not authenticate anyone. Anything that can reach that port
  reaches the guest's server, and the guest's server can do whatever the guest
  can.
- **Snapshots contain the guest's whole state.** Memory, files, anything it
  read or was given. Treat a snapshot directory like the data it came from.
- **The host's file contents are not secret from code you pass in.** Anything
  you write into the sandbox with `files.write`, or mount with `packages`, or
  put in `envs`, is readable by the guest.

## Reporting

Found an escape? Open a private security advisory on the repository. Every
escape we fix gets a test in `isolationtest.mjs` first.
