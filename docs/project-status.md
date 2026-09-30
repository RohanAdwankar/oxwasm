# Project status, layout and development host tools

Moved out of the README, which is now about using the sandbox SDK.

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
