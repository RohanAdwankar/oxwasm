# oxwasm

Package unmodified Linux software as **a single static HTML file**.

```
$ ./fetch-runtime.sh
$ ./make-demo.sh
oxwasm: wrote linux.html (14.6 MB, fully self-contained)
$ open linux.html
```

`linux.html` is the entire deliverable: an unmodified Ubuntu 18.04 kernel and
busybox userspace booting to an interactive shell **inside the tab**. No
server, no install, no network — open it from disk, host it on any static
site, or email it to someone. Issue: drapoz/0#1345.

## How it works

```
oxwasm build --kernel vmlinuz --initrd initrd.gz -o out.html
oxwasm build boot.iso -o out.html

┌────────────────────────── out.html ──────────────────────────┐
│  engine (v86: x86 → WASM JIT)   ·   SeaBIOS + VGABios        │
│  your guest bytes, base64-inlined, byte-for-byte unmodified  │
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

The end goal (issue #1345): `oxwasm gimp.AppImage` → a static site that runs
GIMP. Not a rewrite of GIMP, not a streaming server — the real program,
running client-side. GIMP is the forcing function because it is brutally
honest: multi-process, threaded, GTK, spawns plug-ins, needs a display
server and a filesystem. A runtime that carries GIMP carries most software.

## Milestones

- **M1 — one command, one file, real Linux. Done.** Unmodified kernel +
  userspace boot to an interactive shell in a single offline HTML file
  (~6 s to a prompt in headless Chromium).
- **M2 — pixels. Done.** `make-gimp-demo.sh` builds a stock Ubuntu bionic
  i386 guest — GIMP 2.8, Xorg (vesa), matchbox, 280 packages, zero bytes
  patched — and packages it as one offline `gimp.html` (179 MB). X is up
  ~1 min after open; GIMP's full UI ~3 min; it accepts keyboard and
  emulated PS/2 mouse input. Slow, real, and entirely client-side.
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
mkcpio.py        pure-Python newc cpio / initramfs builder
fetch-runtime.sh reproduce runtime/ (engine + BIOS)
make-demo.sh     reproduce the M1 demo guest and linux.html
demo-init.sh     the demo guest's /init
platform/        M4 — syscall ABI, processes-as-workers, pipe demo
engine/          M3 — x86-64 decoder, tier-0 interpreter, tier-1 JIT seed
docs/m3-engine.md  M3 — the x86-64 -> WASM JIT design
```
