# GUI harness: boot, snapshot, pack, verify

The workflow that produced the GIMP/leafpad single-HTML pages, kept here so
every result is reproducible end to end.

## 1. Boot a GUI binary and snapshot it

```
node guishot.mjs SYSROOT /usr/bin/gimp-2.8 out.ppm 1024x768 600
```

`guishot.mjs` runs a binary from a sysroot on the M3 engine with the
in-process X server, screenshots at idle, and honors env knobs:

- `SNAPSAVE=path` — snapshot the settled engine (writes `path.json`,
  `path.blobs`, `path.mem`, and `path.units`, the sha1 manifest of every
  AOT unit assembled during the run).
- `SNAPLOAD=path` — restore instead of booting.
- `CLICK=x,y[:x,y...]`, `POLLWD=1`, `SHADOW=1`, `CHAINSLOW=1`,
  `CALLTH=n`, `LOOPTH=n` — input injection and engine diagnostics.

A persistent `watcache/` (sha1 → wasm) makes recompiles cheap across runs;
the `.units` manifest is what lets `xpack.mjs --snapshot` pre-bake every
compiled unit into the page so the browser never needs wabt.

## 2. Pack a page

```
node ../xpack.mjs SYSROOT /usr/bin/gimp-2.8 page.html \
  --snapshot snap_gimp --mem 1024
```

## 3. Verify in a real browser (CDP)

All drivers speak raw CDP over node's native WebSocket to headless
Chromium at `/opt/pw-browsers/chromium` — no puppeteer/playwright dep.

- `cdp_click.mjs page.html out` — wait for `__oxReady`, click guest
  coordinates, screenshot before/after.
- `cdp_type.mjs page.html out` — native keyboard events into the guest.
- `cdp_soak.mjs page.html out` — multi-step interaction soak: open File
  menu, Escape, open Windows menu, Escape, select a toolbox tool;
  screenshots + engine stat line after each step.
- `cdp_aot.mjs page.html` — assert AOT units keep growing in-page.

Guest coordinates are mapped through the canvas bounding rect, so the
drivers work at any page zoom/size.

## Soak result (2026-08-28, gimp_snap3.html)

Restore ~2s, then five interactions: File menu opened and stayed open,
Escape dismissed it cleanly, Windows menu rendered all items, tool click
landed; engine advanced 861.9M → 886.3M interp instrs while in-page AOT
grew 1 → 487 units. All four screenshots pixel-correct.

## Bundle slimming (2026-08-28)

Same snapshot, three packagings of the GIMP page, each passing the
identical CDP soak with pixel-correct screenshots:

| page | units inlined | size |
|---|---|---|
| base64-JSON unit cache (old format) | 2673 (full boot) | 225.1 MB |
| binary unit container | 2673 (full boot) | 204.4 MB |
| binary container + `--units` prune | 668 (post-restore working set) | 178.2 MB |

The working-set manifest comes from a `SNAPLOAD` + `CLICK` script +
`UNITSOUT` guishot run (restore, drive the menus, record which units
tier-up actually requests). A unit missing from a pruned page poisons to
the interpreter — still correct, just unaccelerated — so pruning trades
only cold-path speed for 26 MB.

## Near-native load: sidecar delivery (2026-08-28)

`xpack --sidecar DIR --dedup` replaces the monolith with a load-time
architecture:

- **index.html** (0.6 MB): engine modules + the snapshot's framebuffer
  inlined — the page opens showing the app's real screen before the
  engine even parses.
- **app.state.br** (11.7 MB) + **app.mem.br** (7.7 MB): the critical
  path, fetched sequentially; memory tiles stream straight into wasm
  memory. `--dedup` is what makes mem this small: 219 MB of pages
  byte-identical to sysroot files (mapped library .text/.rodata, inside
  non-writable PT_LOAD segments only) are dropped and reconstructed
  from the files instead — verified bit-exact at pack time.
- **app.rom.br** (30 MB) + **app.units.br** (1.8 MB): deferred. Rom
  carries the file-clean pages' backing files; until each file lands its
  pages are marked pending, and the engine's `Memory.pend` guard turns
  any touch into rewind + short block + retry (interpreter-only window,
  AOT thresholds parked at Infinity, re-armed when units apply). A click
  issued while 40 MB of libraries were still streaming rendered the File
  menu pixel-perfect (`cdp_stall.mjs`).

**The bundle is static-host-agnostic by default**: sidecars are plain
gzip files the page inflates itself (`DecompressionStream`), so any file
server works with zero configuration — GitHub Pages, S3, nginx,
`python3 -m http.server`. `--br` opts into brotli sidecars instead
(~30% less wire; the 101 MB of unit wasm compresses 56:1 under brotli's
16 MB window vs ~10:1 under gzip's 32 KB) for hosts that can send
`Content-Encoding: br`. Memory runs are page-granular, so restore decode
cost tracks real data (48.8 MB raw), not tile padding.

`serve.mjs DIR PORT [Mbps]` serves either variant; the optional Mbps arg
paces all responses through one token bucket (50 ms burst) at the
socket, because Chrome's DevTools network emulation caps large downloads
at ~20-35 Mbps regardless of the configured profile. Repeat visits ride
the plain HTTP cache; a cache-first service worker was tried and
rejected (the Cache API stores decoded bodies — ~600 MB for this
bundle — slower on both visits than re-decoding).

Static-bundle numbers (gzip sidecars, same driver): cold interactive
**1.12 s** on an unthrottled stock `python3 -m http.server`, **2.53 s**
at a socket-paced 100 Mbps, repeat 1.3–1.6 s; File menu pixel-correct
after each run. The brotli table below predates page-granular memory
runs and reads slightly worse than the current bundle.

Measured with `cdp_load.mjs` (headless Chromium, server-paced link,
fresh profile for cold; milestones are `performance.now()` marks the
page records, cross-checked against resource timing):

| link | first paint | click-to-interactive, cold | repeat visit | all sidecars done |
|---|---|---|---|---|
| 50 Mbps  | 112 ms | 3.90 s | 1.73 s | 9.1 s |
| 100 Mbps | 127 ms | 2.68 s | 1.77 s | 5.4 s |
| 300 Mbps | 104 ms | 1.64 s | 1.66 s | 2.7 s |

After each cold visit the driver opens the File menu with a native click
and screenshots it: correct at every profile, with 535+ AOT units live.
