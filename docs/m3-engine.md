# M3 — the fast engine: x86-64 → WASM JIT

## Why this is the core project

The current engine (v86) JIT-translates 32-bit x86 to WASM and is fast
enough to boot a distro kernel in seconds and run Xorg + GIMP 2.x. It will
never run an AppImage: AppImages are x86-64, and v86 stops at 32 bits.

Today exactly one engine in the world JITs x86 in the browser at usable
speed for 64-bit-era desktop software: CheerpX. It is proprietary. The open
alternatives (Bochs, TinyEMU under WASM) are interpreters, 10–100× slower.
So the open slot oxwasm must fill is precisely: **an open-source x86-64 →
WASM JIT**. Everything else in oxwasm is packaging around whichever engine
sits in this slot.

## Architecture (target)

```
guest pages ──> decoder ──> basic blocks ──> IR (light SSA) ──> wasm emit
                   ^                                               │
                   └────────── invalidation on self-mod write <────┘
                                (page-granular, like v86)
```

- **Tier 0**: interpreter for cold code, boot paths, and correctness oracle.
- **Tier 1**: per-basic-block baseline JIT — direct x86→wasm lowering,
  registers pinned to wasm locals, flags computed lazily (the classic
  trick; v86 and CheerpX both live on it).
- **Memory**: guest physical memory = one big `WebAssembly.Memory`; 64-bit
  guest virtual addressing via software TLB (inline check + slow-path
  call). Memory64 removes masking overhead when it's everywhere.
- **New modules per code region**, swapped in via table patching —
  `WebAssembly.Module` instantiation is cheap enough at block granularity
  (v86 proves this in production).
- **SIMD**: SSE2 maps well onto wasm SIMD128. x87 through softfloat.

## Sequencing

1. Long mode decode + tier-0 interpreter, validated against a differential
   harness (same instruction stream through qemu-user / hardware, compare
   architectural state per block). The harness is the real asset: it makes
   every later tier honest.
2. Tier-1 for the hot 20 opcodes; measure on GIMP's actual startup trace.
3. Syscall-level fast path: once the JIT runs userspace well, a Linux
   syscall emulation layer (the M4 kernel surface) can skip the guest
   kernel entirely for AppImages — processes become workers, and the two
   lanes converge.

## Interim engine posture

`oxwasm build` keeps a pluggable engine: v86 today; a Bochs-class x86-64
interpreter could make `oxwasm gimp.AppImage` *literal* before it is
*usable*, at the cost of minutes-long startup — worth it only as a CI
correctness target, not as the demo. The JIT is the product.

## The terminal lane (tty, ptys, line discipline)

`ioctl` used to answer ENOTTY for everything, so nothing that expects a
terminal worked. Three things have to agree before glibc accepts one, and
each was found by a distinct failure rather than by reading headers:

- **TCGETS fills the KERNEL `struct termios`** — four u32 flags, a u8
  `c_line`, then `c_cc[19]`: 36 bytes. glibc's user-facing struct is 60,
  with `c_ispeed`/`c_ospeed` appended. Writing all 60 overruns the caller's
  buffer, and the guest said so: `*** stack smashing detected ***`.
- **Process-group calls must agree with `TIOCGPGRP`.** With `getpgrp`
  unimplemented, dash's `while (getpgrp() != tcgetpgrp(fd))` never
  converged — 1,279,865 ioctls in one run before it was killed.
- **Every stat flavour must report the same char device.** `ttyname()`
  readlinks `/proc/self/fd/N` and then stats the answer, comparing
  `st_rdev`/`st_ino` against the fd's `fstat`. `newfstatat` has its own
  handler and was the last one still returning ENOENT, which is why `tty`
  kept printing "not a tty" after the other three agreed.

A **pty pair** is two pipe buffers crossed: what the master writes the slave
reads (the keyboard), what the slave writes the master reads (the screen).
Both ends share one termios, so a `TCSETS` through either is visible to the
other — that sharing is the point of the pair, and it is why the console's
termios had to stop being a single global. The handles carry `pipe` for
their read side and `wpipe` for their write side, so `read(2)` and `poll(2)`
treat a pty end exactly like a pipe and only `write(2)` knows the
difference; the blocking and EOF semantics come free from the pipe lane.

The **line discipline** is where a terminal stops being a pipe. In canonical
mode it hands the reading program whole lines, buffering until Enter and
letting ERASE and KILL edit what is pending; ECHO shows the *edited* text,
so an erase un-draws the character rather than echoing `0x7f`. Clear ICANON
and it is a passthrough again, which is what a curses app needs.

## X core fonts, and a lesson about whose bug it is

Athena/Xt clients (xmessage, xfontsel, xclock, xedit) load a **server-side**
core font at startup and abort if none exists. GIMP never exposed this: GTK
rasterizes glyphs client-side with Xft and ships them as images, so the
server's core-font path was only ever exercised by whatever PCFs a harness
passed in. On a machine with no `xfonts-base` there are none, so every
Athena app died before mapping a window. `engine/font5x7.mjs` is a built-in
5x7 font appended *after* any supplied PCFs, so a real font always wins and
it only answers requests that would otherwise have found nothing.

That fixed the abort. It did **not** fix "Unable to load any usable
fontset", and the hunt for that is worth recording because two plausible
theories were wrong:

- *ListFontsWithInfo returns only a terminator.* An `XFONTTRACE` run shows
  Xlib never calls `ListFonts` **or** `ListFontsWithInfo` for a fontset — it
  does `OpenFont` on an XLFD pattern and then `QueryFont`, both of which
  already succeeded.
- *The font claims iso8859-1 but covers only ASCII.* Extending it to the
  full range changed nothing, so the change was reverted rather than kept on
  a disproved rationale.

The actual cause was **not in the server at all**: the probes' file set
never included `/usr/share/X11/locale`, so Xlib could not build a fontset
whatever the server answered. The tell had been the *first* warning in every
run from the beginning — "locale not supported by Xlib" — read past in
favour of the fontset line underneath it. With the locale tree supplied the
guest's stderr is completely empty.

Two commits were written against those wrong theories. Both stand on their
own merits — a real server does return every matching name from `ListFonts`,
and does report font properties from `QueryFont` — but neither was the
blocker, and saying so before measuring is the mistake to avoid repeating.
The `QueryFont` change also moved the per-character metrics, which had
started at a fixed offset 60; `xserver.mjs` is bundled into the packed GIMP
page, so that layout is now checked byte-for-byte in `fonttest.mjs`.

### Where xmessage stands, precisely

It paints: window frame, message area, button box, and the button's label
rendered from the built-in font. What is missing is the **message text**, and
the measurements narrow it a long way:

- The only string that ever reaches the server is `"okay"`, from the button.
  The message draw is never issued, so this is not a rendering bug.
- The message widget (78x12 at 4,4 for a 12-character message) is sized
  exactly from our font metrics — 12 chars x 6px plus padding — so it knows
  both the string and the font, and `QueryFont` is working.
- It sits inside an 88-wide container, so it is not clipped.
- It receives its Expose (event mask 0x20853d, Exposure bit set), and the
  server sends no error on any request in the connection ring.
- The last three requests are MapWindow, PolyText8("okay"), then
  SetClipRectangles and silence: a widget set up its clip to draw and then
  decided there was nothing to draw.

Two explanations have been tested and are wrong. It is not the fontset
(`XmbDrawString`) path: running with `-xrm '*international: false'` changes
nothing. It is not a missing request: ClearArea, CopyArea, PolyFillRectangle
and the rest are all implemented, and no error was returned.

The remaining difference between the widget that draws and the one that does
not is their class — a Command button versus an Xaw Text widget, whose
Redisplay goes through a text source and sink and draws per computed line.
The next thing to establish is whether that line table is being built at all,
which is a question about Xaw internals rather than about the server.

### What the terminal lane now runs

Three programs, each exercising a different part of it:

- **xterm**, driven by real keystrokes through the X server, round-trips a
  whole session. Typing `echo hi` sends `"echo hi\n"` to the shell and brings
  back `"# echo hi\nhi\r\n# "` — prompt, echo, output, next prompt. ICANON
  held the line until Enter, ECHO returned the characters, ONLCR expanded the
  shell's LF to CRLF.
- **less** clears ICANON and ECHO through TCSETS, loads its terminfo entry,
  draws 707 bytes of first screen (alternate screen, keypad mode, the file),
  takes `q` as a single keystroke without waiting for Enter, and exits 0.
- **nano** does the same with 76 escape sequences and a real editor UI —
  "GNU nano 7.2", "[ Read 40 lines ]", and the `^G Help  ^O Write Out` bar —
  and quits cleanly on Ctrl-X.

The raw-mode cases matter because they are the half a shell session never
reaches: single-character reads, terminfo, and a termios change made by one
end of the pty being visible to the other.

Getting here needed a correctness fix nothing else had surfaced. A vfork
child runs in the PARENT's address space, and while its own stores were
journaled, a syscall writes its RESULT straight into guest memory and
bypassed the journal entirely. Two of those were live crashes — `ioctl
TCGETS` put 36 bytes of termios over the parent's stack canary, and
`readlink` wrote "/dev/pts/0" over a return address, faulting to
`0x7374702f76656447`, that path in hex. The rest were latent, waiting for a
program whose child happened to `read()` or `poll()` before exec.
`engine/diff/jrnltest.mjs` pins the whole class.


## Funcref table headroom, measured

`FTMAP_MAX` caps the funcref table at 20,000 entries and the failure past it is
silent: `registerAotFn` simply returns, and every cross-unit call to that
function takes the `x_callout` JS round-trip forever with nothing to see.

The shipped GIMP demo, counted from `demo/gimp/app.units.gz`:

| | |
|---|---:|
| packed units | 7,653 |
| distinct `f_` exports (mapped functions) | **13,173** |
| share of the 20,000 ceiling | 66% |
| FTHASH load factor (32,768 slots) | 40% |

So the ceiling is not reached by the product today, but 1.5x of headroom on a
silent cliff is not much. `registerAotFn` now counts refusals in `_ftFull`,
which is the cheap half of the fix — the cliff becomes visible before anyone
has to guess at it.

Raising the ceiling is the other half, and it is coupled: `$ftr` probes FTHASH
linearly over `FTSLOTS` = 32,768 entries, so past roughly 26,000 mapped
functions the probe chains degrade, and at 32,768 a lookup for an unmapped
address would never find an empty slot to terminate on. FTMAP_MAX cannot move
without the hash moving with it. The dead space from `FTMAP+16` to `FTHASH`
(about 320KB) is where that growth would come from, together with the 8-byte
slot change — but none of it is worth doing until something actually crosses
13,173.
