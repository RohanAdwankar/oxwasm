# oxwasm

Turn **any** unmodified Linux program into **a single static HTML file** that
runs it in the browser — no server, no install, no network.

```
$ ./fetch-runtime.sh
$ ./pack-app.sh examples/gimp.app  -o gimp.html      # GIMP
$ ./pack-app.sh examples/xcalc.app -o xcalc.html     # a calculator
$ open gimp.html
```

The `.html` is the entire deliverable: open it from disk, host it on any
static site, or email it. Inside is a WebAssembly machine that boots a tiny
Linux and runs the program you named. **The tool is general — GIMP is just
the test case.** `examples/xcalc.app` is the same pipeline with a different
program; a new app is a new spec, not new code. Issue: drapoz/0#1345.

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
machine state**, so opening the HTML restores a ready app instead of booting
(GIMP: ~6 s of restore compute vs ~2 min of cold boot). See
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

The end goal (issue #1345): `oxwasm anything.AppImage` → a static site that
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
- **M3 — speed, and the actual AppImage. Foundation verified.** AppImages
  are x86-64; v86 executes 32-bit x86 only. The fast path is an x86-64 →
  WASM JIT — the engine oxwasm must own (the only comparable engine today,
  CheerpX, is proprietary). `engine/` has a decoder, a tier-0 interpreter
  proven step-for-step against the real CPU (`ptrace` single-stepping —
  316 synthetic cases + gcc -O1/-O2 output, ~6700 instructions, zero
  divergence), and a tier-1 JIT seed that emits real WebAssembly matching
  the interpreter. `engine/test.sh` runs the suite. Design and next steps:
  `docs/m3-engine.md`. This is the core project; the foundation is real,
  the hot-path JIT is the road ahead.
- **M4 — the platform. Spike running.** `platform/` is the second lane:
  a syscall ABI as wasm imports, processes as workers, pipes as
  SharedArrayBuffer rings with real blocking reads. Two freestanding C
  programs run `producer | upper` to completion in Chromium — see
  `platform/README.md`. M3 runs everything; M4 makes flagship apps fast.
  They converge: same kernel surface, two ways in.

## Layout

```
oxwasm.py        CLI — packs engine + BIOS + guest into one HTML
pack-app.sh      turn any app spec into a single-file HTML (the general tool)
examples/*.app   app specs (gimp, xcalc) — data, not code
resolve-debs.py  dependency-closure resolver over the Ubuntu archive
mkcpio.py        pure-Python newc cpio / initramfs builder
fetch-runtime.sh reproduce runtime/ (engine + BIOS)
make-demo.sh     reproduce the barebones M1 guest and linux.html
demo-init.sh     the M1 guest's /init; guest/oxinit is the generic graphical init
platform/        M4 — syscall ABI, processes-as-workers, pipe demo
engine/          M3 — x86-64 decoder, tier-0 interpreter, tier-1 JIT seed
docs/m3-engine.md  M3 — the x86-64 -> WASM JIT design
```
