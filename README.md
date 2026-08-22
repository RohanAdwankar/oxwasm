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
  userspace boot to an interactive shell in a single offline HTML file.
- **M2 — pixels.** A 32-bit graphical guest: X11 + GIMP 2.x (i386 build)
  through the same pipeline. v86 already emulates SVGA; this is guest
  assembly work, not engine work. Expect it to run, and to be slow.
- **M3 — speed, and the actual AppImage.** AppImages are x86-64; v86
  executes 32-bit x86 only. The fast path is an x86-64 → WASM JIT — the
  engine oxwasm must eventually own (today's only comparable engine,
  CheerpX, is proprietary). This is the core project.
- **M4 — the platform.** The second lane from the design discussion:
  a browser syscall ABI + processes-as-workers + Wayland-ish display, with
  software *recompiled* to WASM as packages — native speed, no emulation.
  M3 runs everything; M4 makes flagship apps fast. They converge: same
  kernel surface, two ways in.

## Layout

```
oxwasm.py        CLI — packs engine + BIOS + guest into one HTML
mkcpio.py        pure-Python newc cpio / initramfs builder
fetch-runtime.sh reproduce runtime/ (engine + BIOS)
make-demo.sh     reproduce the M1 demo guest and linux.html
demo-init.sh     the demo guest's /init
```
