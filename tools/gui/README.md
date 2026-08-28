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
