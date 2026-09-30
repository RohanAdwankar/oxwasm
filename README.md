# oxwasm

**A code sandbox for AI agents that runs inside your process.** No VM to boot, no
container to manage, no cloud account, no per-second bill. `npm install`, then:

```js
import { Sandbox } from 'oxwasm'

const s = await Sandbox.create()          // ~2 s, from a snapshot

await s.run('x = 10')                     // real CPython, and it remembers
await s.run('print(x * 5)')               // -> "50\n"
await s.sh('ls /')                        // a shell, when you want one

await s.files.write('/work/data.csv', csv)
await s.run('import csv; ...')            // read it back from python

await s.close()
```

The guest is an **unmodified x86-64 Linux CPython** executing inside a
WebAssembly engine, in a worker thread of your own Node process. It has no
route to your machine: it makes syscalls, the engine answers them, and nothing
reaches the real kernel. Its filesystem is a JavaScript object; a file it
writes never exists on your disk.

## The API

Everything hangs off the sandbox, `s`. Each job has a **simple call** that
returns the answer, and a **detailed twin** that returns a result object, for
when you want to stream output, keep results separate, or handle errors
yourself. They run the same code.

| To do this | Simple | Detailed |
|---|---|---|
| Run Python | `await s.run(code)` | `await s.runCode(code)` |
| Run a shell command | `await s.sh(cmd)` | `await s.commands.run(cmd)` |
| Read / write files | `s.files.read(path)`, `s.files.write(path, data)` | (same) |
| Stop | `await s.close()` | `await s.kill()` |

```js
const s = await Sandbox.create()

// Simple: you get text back. A Python error throws.
await s.run('x = 10')
await s.run('print(x * 5)')          // "50\n"   what it printed, then its last expression
await s.sh('ls /')                    // { stdout, stderr, exitCode } - never throws on a nonzero exit

// Detailed: you get a result object. A Python error is a field, not an exception.
const r = await s.runCode('x = 1; x + 1')
r.text                                // '2'      the last expression only
r.logs.stdout                         // ['...\n']  lines it printed, newline included
r.error                               // undefined, or { name, value, traceback }

await s.commands.run('cat /a.txt')    // throws CommandExitError on a nonzero exit
```

Use the simple calls to get going. Reach for `runCode` when you are wiring
this into an agent and need output, results and errors kept apart. One detail
that trips people: in the detailed form, `r.text` is the **last expression
only**; what the cell `print`s is in `r.logs.stdout`.

The detailed form also has separate code contexts (`createCodeContext`),
streaming callbacks (`onStdout`, `onStderr`, `onResult`, `onError`), per-call
`envs` and `timeoutMs`, background commands, and `Sandbox.connect(id)` within
the same process. Errors are typed (`TimeoutError`, `CommandExitError`,
`FileNotFoundError`, ...).

**Not implemented, and they say so instead of pretending:** `pty`, `git`,
`getHost` and any inbound network, `watchDir`, pause/snapshot/fork, and
languages other than Python. Those throw `NotSupportedError`.

## What it is and is not

| | oxwasm | E2B | Pyodide-based (e.g. LocalSandbox) | Rivet agentOS |
|---|---|---|---|---|
| Where code runs | a worker thread in your process | their cloud, or microVMs you run yourself | in your process | in your process (V8 isolates + Wasm) |
| Infrastructure | none | an account and API key, or run the stack yourself | none | none |
| What the guest is | a real Linux userland | a real Linux VM | Python compiled to Wasm | JS on V8, plus tools compiled to Wasm |
| Native Python packages | **ordinary x86-64 wheels**, mounted from the host | anything you can `pip install` | only those rebuilt for Wasm | not documented; tools ship from their registry |
| Shell and CLI tools | a provisioned set of coreutils | everything | none | a provisioned set |
| Outbound network | none | yes | varies | opt-in |
| Cold start | ~2 s (restore); ~50 s first time on a machine | not measured here | not measured here | ~6 ms (their figure) |
| Compute speed | several times slower than native | native | slower than native | not measured here |
| Scales out | your CPU, one core per busy sandbox | their pool | your CPU | your CPU |

The row that is the reason this exists is native packages. Wasm-based
sandboxes can only run C extensions someone rebuilt for WebAssembly, so the
long tail of `pip install` does not work there. Here the guest is the real
CPython for your host, so a manylinux wheel is an x86-64 shared object its own
dynamic loader loads. `msgpack`'s compiled extension imports and round-trips
today with nothing recompiled.

**Where it loses, plainly:**

- **It is not fast.** It is x86 emulation. Tight CPython loops run roughly
  6-15x slower than native in this repo's own benchmarks (`bench/README.md`).
  Light scripting and glue code is fine; heavy numeric work is not what this
  is for.
- **The first cells after a restore are slow** (0.5-2 s each) while the compiled
  tier re-warms; steady state is ~15-60 ms per cell after about ten cells.
- **No network in the guest.** `apt install` and `pip install` at runtime do
  not work. Software is provisioned from the host: `packages: ['/path/to/site-packages']`.
- **numpy does not run yet.** It loads and then reaches SSE4.1 instructions the
  decoder does not implement (fourteen opcodes, counted). A bounded gap, but open.
- **Spawning many subprocesses is broken today.** `commands.run` starts
  failing after about eight calls: a fault in the engine's compiled-code path
  for CPython's process spawn, reproducible and not yet fixed
  (`engine/diff/sandboxtest.mjs` reaches it).
- **It saves you the per-second bill, not the compute.** The CPU is yours. It
  is cheaper when sandboxes are many and light; it is not when they are few
  and heavy.

## Install

```
npm install github:RohanAdwankar/oxwasm
```

Node 22+, Linux x86-64, and `wat2wasm` (`apt install wabt`) on the host: the
engine assembles the WebAssembly it generates with it. A missing `wat2wasm`
is an error at startup, not a silent slowdown. The first `Sandbox.create()`
on a machine takes about a minute to boot and warm CPython and saves a
snapshot under `~/.cache/oxwasm` (override with `OXWASM_CACHE`); every create
after that restores it.

```js
Sandbox.create({
  packages: ['/path/to/site-packages'],  // mounted, and put on PYTHONPATH
  timeoutMs: 300_000,                    // sandbox lifetime
  envs: { KEY: 'value' },
  memMB: 512,
})
```

A cell that runs past its `timeoutMs` gets a SIGINT (Python raises
`KeyboardInterrupt`; the sandbox survives with its state) and, if it does not
answer within five seconds, its worker thread is terminated. A `while True:
pass` therefore costs you that sandbox, never the host.

---

## Also: any Linux program as one HTML file

The engine underneath is general, and this is what it was built for.

Turn **any** unmodified Linux program into **a single static HTML file** that
runs it in the browser — no server, no install, no network.

```
$ ./fetch-runtime.sh
$ ./pack-app.sh examples/gimp.app  -o gimp.html      # GIMP
$ ./pack-app.sh examples/xcalc.app -o xcalc.html     # a calculator
$ open gimp.html
```

The `.html` is the entire deliverable: open it from disk, host it on any
static site, or email it.

**macOS / Windows:** the build assembles a Debian/Ubuntu i386 guest, so it
needs Linux packaging tools (`dpkg-deb`, `mke2fs`). If they aren't on the
host, `pack-app.sh` detects that and transparently re-runs the whole build
inside a Linux container — just have Docker installed and run the same
command. The first run builds a small one-time builder image; the output
`.html` lands in your current directory as usual. (`OXWASM_NO_DOCKER=1`
forces the native path; `--snapshot` additionally needs Node + headless
Chromium, so run that step on Linux.) Inside is a WebAssembly machine that boots a tiny
Linux and runs the program you named. **The tool is general — GIMP is just
the test case.** `examples/xcalc.app` is the same pipeline with a different
program; a new app is a new spec, not new code.

## The tool is program-agnostic

An app spec is a few lines — a package name and a command:

```sh
# examples/gimp.app
PACKAGES="gimp"
RUN="gimp"
WM="matchbox-window-manager -use_titlebar yes"
```

`pack-app.sh` resolves that program's dependencies from the Ubuntu archive,
assembles a guest around it, and packages it. Nothing about any specific
application lives in the tool; the only app-specific bytes in the whole guest
are the one line written to `/etc/oxwasm-run`. Swap the spec, get a different
program in the browser. `make-demo.sh` builds the barest guest of all — just
a kernel and a shell — in one offline `linux.html`.

Add `--snapshot` to boot the app once at build time and ship a **frozen
machine state**, so opening the HTML restores a ready app instead of booting.
With `--split-state` (state as a streamed sidecar) and `--split-disk` (disk
as a lazily-fetched Range-request device, so snapshots exclude disk
contents), the hosted page restores **GIMP in 1.6 s — faster than the same
GIMP starts natively (2.0 s) on the same machine**; `tools/rangeserver.py`
serves it locally. See
`docs/performance.md` for the measured numbers and the honest ceiling —
short version: snapshot fixes *startup*; near-native *runtime* needs the
M3 JIT or M4 recompile lane, because emulation's per-instruction overhead is
irreducible.

## How it works

```
oxwasm build --kernel vmlinuz --initrd initrd.gz -o out.html
oxwasm build boot.iso -o out.html

┌────────────────────────── out.html ──────────────────────────┐
│  engine (v86: x86 → WASM JIT)   ·   SeaBIOS + VGABios        │
│  your guest bytes, gzip-inlined, byte-for-byte unmodified    │
│  a screen, a keyboard, a loading line                        │
└──────────────────────────────────────────────────────────────┘
```

The M1 engine is [v86](https://github.com/copy/v86) (BSD-2-Clause): an
x86 machine emulator that JIT-translates guest machine code to WebAssembly
at runtime. Everything is inlined into the one file — the engine, the BIOS,
and the exact bytes of the guest you gave it. Nothing is fetched at load
time; the page works offline and hosts anywhere static files go.

Measured (headless Chromium, this container): cold open → interactive shell
in ~6 s wall clock; guest kernel reports 4.3 s boot.

`mkcpio.py` builds guest initramfs images in pure Python, so the host needs
no cpio/mkisofs. `fetch-runtime.sh` pulls the engine from npm and the BIOS
from the Ubuntu archive; `make-demo.sh` pulls a bionic i386 kernel + static
busybox and emits `linux.html`. Every guest byte is stock distro output —
oxwasm never patches the software it packages.

## Why

The end goal: `oxwasm anything.AppImage` → a static site that
runs that program. Not a rewrite, not a streaming server — the real program,
running client-side. The tool is general on purpose; GIMP is only the
forcing function, because it is brutally honest: multi-process, threaded,
GTK, spawns plug-ins, needs a display server and a filesystem. A runtime
that carries GIMP carries most software — so nothing about GIMP is baked in.

## Milestones

- **M1 — one command, one file, real Linux. Done.** Unmodified kernel +
  userspace boot to an interactive shell in a single offline HTML file
  (~6 s to a prompt in headless Chromium).
- **M2 — pixels, for any app. Done.** `pack-app.sh SPEC -o out.html` builds
  a stock Ubuntu bionic i386 guest around whatever program the spec names
  (Xorg vesa + matchbox + the app's dependency closure, zero bytes patched)
  and packages it as one offline HTML file. Proven on two unrelated
  programs: GIMP 2.8 (`gimp.html`, 179 MB, full UI ~3 min, keyboard +
  emulated mouse) and xcalc (`xcalc.html`, 89 MB, ~1 min). Slow, real,
  entirely client-side — and not specialized to any one app.
- **M3 — speed, and the actual AppImage. Shipped for x86-64.**
  `oxwasm build prog` (an x86-64 ELF, static or dynamic) or
  `oxwasm build app.AppImage`
  emits one self-contained HTML that runs the unmodified binary in the tab:
  a tier-0 interpreter proven against the real CPU by `ptrace`
  single-stepping (316 synthetic cases + real gcc output, zero divergence)
  profiles the run and AOT-compiles hot call-graph closures to WebAssembly
  **at runtime, in-page** (wabt assembles the emitted WAT). Verified in
  headless Chromium on stock Ubuntu busybox (echo/wc/sort/md5sum/sha256sum
  bit-exact), a glibc-static md5 program, and a real third-party AppImage
  (appimagetool's continuous build) — output and exit codes identical to
  native. Hot compute runs at **0.84x–1.4x native** (see
  `engine/aot/RESULTS.md`; wasm can beat native); cold code interprets, so
  seconds of warmup precede steady state. AppImages are unpacked host-side
  (pure-python squashfs — a browser has no FUSE) and the payload rides in
  the guest FS, bytes unmodified. **Dynamically-linked programs run too** —
  the packer bundles the `PT_INTERP` loader and the resolved library
  closure, and the breadth sweep runs 170 unmodified stock system binaries
  byte-identical to native: gcc through to its linker, clang, python3,
  node, rustc under cargo, ffmpeg, git, perl, vim on a pty, an OpenJDK JVM
  compiling with javac. `docs/breadth.md` lists every one. **GUI programs
  run on this lane too**, against the engine's own X server rather than the
  v86 machine: GIMP 2.8 opens a canvas and draws in a tab. The limit still
  worth stating plainly: no x87 long-double, so a `printf("%Lf")` path
  prints double-precision digits where the hardware prints 80-bit ones.
  `engine/test.sh` runs the differential suite, `tools/breadth.mjs` the
  breadth sweep, and `engine/aot/bench-all.mjs` reproduces the performance
  table.
- **M4 — the platform. Spike running.** `platform/` is the second lane:
  a syscall ABI as wasm imports, processes as workers, pipes as
  SharedArrayBuffer rings with real blocking reads. Two freestanding C
  programs run `producer | upper` to completion in Chromium — see
  `platform/README.md`. M3 runs everything; M4 makes flagship apps fast.
  They converge: same kernel surface, two ways in.

## Layout

```
oxwasm.py        CLI — v86 lane (kernel/ISO/disk -> HTML) + M3 lane (x86-64 ELF/AppImage -> HTML)
pack-app.sh      turn any app spec into a single-file HTML (the M2 general tool)
examples/*.app   app specs (gimp, xcalc) — data, not code
resolve-debs.py  dependency-closure resolver over the Ubuntu archive
mkcpio.py        pure-Python newc cpio / initramfs builder
fetch-runtime.sh reproduce runtime/ (engine + BIOS)
make-demo.sh     reproduce the barebones M1 guest and linux.html
demo-init.sh     the M1 guest's /init; guest/oxinit is the generic graphical init
tools/m3pack.mjs        M3 packer: ELF/AppImage -> single HTML with in-page JIT
tools/appimage-extract.py  type-2 AppImage unpack without FUSE (pure python)
sdk/             the code-sandbox SDK: index.mjs (API), worker.mjs, host.mjs (engine + snapshots), image.mjs, guest.py
platform/        M4 — syscall ABI, processes-as-workers, pipe demo
engine/          M3 — decoder, hardware-verified interpreter, runtime AOT x86-64 -> wasm
docs/m3-engine.md  M3 — the x86-64 -> WASM JIT design
```

## Host tools for a development run

The browser assembles WAT in-page with wabt.js and needs nothing installed.
A run under node shells out instead, so a development machine needs:

```
wat2wasm (wabt)   the AOT tier's assembler -- every translated unit goes
                  through it. Without it each unit is refused and the guest
                  runs on the interpreter: correct output, no AOT tier, many
                  times slower. `makeAssembler` proves it works at startup
                  rather than letting a whole run tier down in silence.
nasm              builds the engine's asm fixtures (tools/fixtures/*.asm)
busybox-static    the process-machinery tests (attest, shelltest) and three
                  breadth cases run a real static busybox. It has to be the
                  -static package: Ubuntu's plain `busybox` is dynamic, and
                  the tests skip rather than run against it.
ffmpeg zstd       breadth cases; a missing one is skipped, so the sweep
                  silently gets smaller
```
