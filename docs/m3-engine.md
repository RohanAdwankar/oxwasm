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

## CPython 3.11: it runs, it just cannot exit

The task tracking this said CPython "faults during startup", which was wrong,
and the correction came from printing the guest's stdout rather than only its
fault address.

```
python3 -S -c "print(6*7)"
  pure interpreter : out: 42, then fault: 0xaf @rip 0x5241f5 after 15.28M insns
  JIT (134 units)  : out: 42, then wasm "memory access out of bounds" at 4.30M
```

**It prints 42.** The `write` syscall is in both histograms. CPython loads its
stdlib, compiles and executes Python code, produces correct output, and then
crashes tearing the interpreter down. That is a shutdown-path defect, not a
broken CPython, and the breadth story is much better than the task claimed.

Two further facts narrow it hard.

**Both tiers fail in the same function.** Bisecting the JIT on `unitFilter` -
compile only the first N units, interpret the rest - names unit **134** exactly:
133 is clean, 134 traps, and every point from 136 to 327 traps. Unit 134's
entry is `0x524120`. The interpreter's fault is at `0x5241ee`, inside that same
function - a walk over a 16-byte-stride table of object pointers, dereferencing
`ob_type` and testing `Py_TPFLAGS_HAVE_GC`. One bug, two surfaces.

**Which points at the decoder rather than at either executor.** The interpreter
and the AOT emitter implement instruction semantics through entirely separate
code paths, so a bug in one would normally show up as a divergence between
them. They agree. What they share is `decode()` - and a misdecoded operand
size or displacement would corrupt both identically.

That makes the next tool a **decoder differential against objdump over whole
binaries**, which tests the one component both tiers depend on and which the
existing instruction-level differential (6,037 instructions against hardware)
only samples. `shadowDispatch` is the wrong instrument here precisely because
both sides would be wrong the same way.

### The decoder is not the CPython bug

The reasoning that pointed at `decode()` — both tiers fail identically, and
`decode()` is what they share — was sound, and wrong. `engine/diff/decodetest.mjs`
now checks every instruction objdump finds in a real binary for the property
that matters: **length**. A wrong length makes the next fetch start
mid-instruction and desynchronises execution silently and identically in both
tiers, which is exactly the shape `shadowDispatch` cannot see.

| binary | lengths exact | wrong |
|--------|--------------:|------:|
| `/bin/true`, `/bin/gzip`, `/usr/bin/sha256sum` | 21,410 | **0** |
| `/usr/bin/python3` | 691,630 | **0** |
| `libc.so.6` | 374,515 | **0** |

**1,066,145 instructions, zero length errors.** The hypothesis is dead, cheaply,
and the suite gains a differential that covers the decoder rather than sampling
it — the existing hardware differential checks 6,037 instructions.

libc's 10,924 unsupported encodings are all AVX/AVX-512 (`vmovdqu`,
`vpcmpeqb`, `kmovd`). They never execute: glibc selects implementations by
IFUNC from CPUID, and the engine does not advertise AVX, so the SSE2 paths are
taken. Unsupported is also the safe outcome — those become `udec` and deopt.

One caveat, stated because it bounds the result: this checks length, not
operand semantics. A misdecoded register or displacement keeps the length right
and still corrupts. What it rules out is the desynchronisation class.

**And it cost one probe bug to learn.** The first run reported 766 decoder
errors. objdump splits an instruction longer than 7 bytes across two lines, and
the continuation carries its own address with no mnemonic rather than being a
bare indented byte run — so every long instruction looked 7 bytes long. The
mismatches were all "ours longer than real", which is the tell: a decoder that
was really wrong would err in both directions.

#### Correction: it is not specific to finalization

The section above called this "a shutdown-path defect". That was inference
from the fault site sitting in a GC walk, and a direct test refutes it.

```
python3 -S -c "import os; os._exit(0)"   fault: 0 @rip 0x63aa15 at 16.01M
python3 -S -c "import sys; sys.exit(0)"  fault: 0xaf @rip 0x5241f5 at 15.33M
```

`os._exit` calls `exit_group` immediately and **skips `Py_FinalizeEx`
entirely**. It still faults. So the corruption is already present before
finalization runs; what finalization does is walk the GC lists and trip over
it. Different subsequent code trips over it in different places — the two
fault sites seen across runs, `0x5241f5` and `0x63aa15`, are both GC-list
walks in different functions.

What the reduction does establish:

| invocation | outcome |
|------------|---------|
| `-S -V` | **exit 0**, 291,630 instructions |
| `-S -c pass` / `-c 0` / `-SI -c pass` | fault, all at ~15.24M |
| `-S -c "import os; os._exit(0)"` | fault, 16.01M |

`-V` does a partial initialisation and exits cleanly. Every form that does a
full initialisation faults, at the same site, regardless of what the program
then does or whether it finalises. So the corruption accumulates during
**interpreter initialisation**, and the search window is the 291k-to-15.2M gap
rather than the teardown.

Next instrument: walk the guest's frame-pointer chain at fault time. That names
the CPython function we are in and who called it, which settles what phase this
is in one run instead of another round of inference.

#### The stack, finally read rather than inferred

Two rounds of inference from the fault address produced one wrong answer and
one wrong correction. `tools/gueststack.mjs` walks the guest's frame-pointer
chain and resolves each return address against `nm`, and settles it in one run:

```
rip  PyObject_GC_Del+0x20b5      <- the faulting read
 #0  PyObject_GC_Del+0x1abe
 #1  PyObject_GC_Del+0xfe9
 #2  PyStaticMethod_New+0xd0
 #3  PyGC_Collect+0x75
 #4  Py_FinalizeEx+0x140
 #5  Py_RunMain+0x18e
 #6  Py_BytesMain+0x2d
 #7  libc __libc_start_main
 #8  _start
```

(The symbol names are nearest-preceding exports, so `PyObject_GC_Del+0x1abe`
and `PyStaticMethod_New+0xd0` are static functions inside the GC, not those
functions themselves.)

So for `-c pass` the fault **is** inside `Py_FinalizeEx` -> `PyGC_Collect`, and
the first claim was right about this invocation. The correction was right too,
about a different thing: `os._exit(0)` skips finalization and still faults, at
a different site, because an earlier GC pass during `import os` trips the same
corruption. Both statements were half of one picture:

- the **corruption** is created during interpreter initialisation;
- the **fault** happens in whichever garbage collection runs next, which for a
  plain `-c` invocation is the one `Py_FinalizeEx` performs.

That is a much sharper target than either version alone. The GC is walking its
generation lists and finding an object whose `ob_type` is garbage, which means
a GC-tracked object was freed without being untracked, or the list linkage was
corrupted. `PYTHONMALLOC=debug` not firing fits: the block was reallocated and
reused rather than merely freed, so no guard byte was ever violated.

#### The corrupted object is a string, and that names the mechanism

The object the GC trips over was created at that address with
`ob_type = 0x9284e0`. Resolving it:

```
$ nm -D --defined-only /usr/bin/python3 | grep 9284e0
00000000009284e0 D PyUnicode_Type
```

It is a **str**. Together with the traversal shape — a walk over 16-byte
`{key, value}` entries testing `Py_TPFLAGS_HAVE_GC`, which is `dict_traverse`
over a `PyDictUnicodeEntry` array — that points at CPython 3.11's interning.

`PyUnicode_InternInPlace` stores the string in the interned dict twice, as key
and as value, and then deliberately drops its refcount by two:

```c
/* The two references in interned dict (key and value) are not counted by
   refcnt. unicode_dealloc() and _PyUnicode_ClearInterned() take care of this. */
Py_SET_REFCNT(s, Py_REFCNT(s) - 2);
```

So every interned string in 3.11 carries an artificially low refcount and
survives only because those two dict references are uncounted by agreement. A
single lost INCREF anywhere on such a string kills it early — and the symptom
is exactly what is observed: the interned dict left holding a dangling pointer
to a block that is freed, reallocated and reused, with the GC's next traversal
reading a recycled `ob_type`.

That is the target: **an interned `str` whose refcount reaches zero during
interpreter initialisation.** Not a class of instruction, not a subsystem — one
object and one missing reference.

Left here deliberately. CPython runs and prints correct output; this is a
crash-at-exit on one binary, and the next step (find the DECREF with no
matching INCREF) wants a reference execution to diff against, which does not
exist yet. The cheaper win is elsewhere.

## First-interaction latency, measured on the shipped artifact

`tools/gui/replay.mjs` restores `demo/gimp` — the actual packed page assets,
not a rebuild — and drives the same interaction repeatedly: click into the
GIMP window, Escape to return to where the round started.

```
  n     ms   interp     aot
  0    703    13593    4000
  1    147      107    1125
  2    142      123    1135
  3    154      123    1149
  4    118       87    1143

first 703ms vs median-of-rest 147ms = 4.79x, spread of the rest +/-24%
first interp 13,593 vs median-of-rest 107
```

**The first interaction costs 4.8x the steady state**, and the mechanism is the
one the task claimed: **13,593 interpreted instructions on the first round
against ~107 afterwards**, a 127x difference. Code on the interactive path that
the capture did not cover runs interpreted until the call threshold tiers it
up, and every subsequent round gets it compiled.

Two honest qualifications. The first round also does more genuine work — it
allocates and realises widgets that later rounds reuse, which is why its AOT
run count is higher too (4,000 vs ~1,140), so not all of the 4.8x is
tiering. And the painted-pixel count does not change across rounds, so this
click is exercising the event and widget path rather than a repaint.

Getting here required three corrections worth remembering. The click target
was originally a guessed coordinate that landed on the root window and moved
GIMP 28 instructions; targets have to come from the window tree (`WINDOWS=1`
lists them). The round originally ended with a second click somewhere else,
which left the UI in a different state each time and collapsed to 4ms by the
second round; Escape makes the round idempotent, which is what makes
first-vs-Nth a comparison of the same thing. And none of it ran at all until
the SPR2 memory-format bug above was fixed.

### What the first interaction deopts

The engine keeps a deopt-landing histogram behind `eng.deoptLog`, which is the
right instrument once the interpreted work is known to sit on addresses that
are already compiled. Round 0 of the GIMP interaction:

```
  3,978 deopts over 16 distinct landings

  3204  libc+0x97fc0                [landing compiled]
   481  libc+0x946c2                [landing compiled]
   159  libc+0x93192                [landing compiled]
    66  libc+0x947ba                [landing compiled]
    47  0x1c90631                   [NOT compiled - in no mapped image]
     4  libX11+0x3f768              [NOT compiled]
     4  libgdk-x11+0x59efb          [NOT compiled]
     3  libgtk-x11+0x24832a         [NOT compiled]
```

Two facts worth separating.

**The volume is concentrated and mostly stays in wasm.** 3,204 of 3,978 deopts
land on one libc address that is itself compiled, so the chain continues
wasm-to-wasm through the `deopt` handler rather than dropping to the
interpreter. Those cost a round trip each, not an interpreted stretch.

**Four landings are uncompiled**, and those are the ones the interpreter
actually runs. The largest, 47 deopts at `0x1c90631`, is in **no mapped image
at all** - not the main binary, whose exec range is `0x400000..` and whose file
is 6MB, so an offset of 0x1890631 into it is past the end. An earlier version
of this output labelled it `gimp+0x1890631`, which was a fallback branch
asserting something the data did not support.

What is still NOT established: that these deopts are what produce the 10,487
interpreted steps attributed to `gtk+0x13adb0`. The attribution is by entry
rip, the deopt log is by landing, and nothing yet connects one to the other.

### #31 has a root cause: the capture missed the interactive path

Attributing interpreted steps to the address that CAUSED them, rather than to
whatever rip was current, settles it. Both `DeoptUnwind` catch sites and the
uncompiled-callout path finish by calling `interpUntil()` with `cpu.rip` set to
where they landed, so wrapping `interpUntil` charges interpretation to its
cause. Charging each frame its delta minus its children's (the calls nest, and
counting them inclusively totalled 112% of the round):

```
interpreted via deopt/callout landings: 12,489 of 13,565 = 92%, over 55 landings

  7224  libgtk-x11+0x65040    [never compiled - no unit covers it]
  1298  libgtk-x11+0x64f40    [never compiled]
  1224  libgtk-x11+0x100a80   [never compiled]
   444  libgtk-x11+0x677b0    [never compiled]
   260  libgtk-x11+0x2452b0   [never compiled]
   247  libgtk-x11+0x254a10   [never compiled]
```

**92% of the first interaction's interpreted work is code the pack-time capture
never compiled**, and one function is 53% of it. Not a dispatch bug, not deopt
quality, not the tiering threshold being wrong in principle: the manifest
simply does not contain the interactive path these clicks take. Rounds 2+ drop
to ~107 interpreted steps precisely because the call threshold compiles those
functions after the first round pays for them.

The fix is therefore capture coverage, and the tooling exists: a `guishot` run
with `CLICK` driving this interaction and `UNITSOUT` recording the units it
requests, repacked into the manifest.

**And this is why the earlier reading had to be held.** The entry-attributed
histogram put 77% of the work on `gtk+0x13adb0`, an address that IS compiled,
which reads as "dispatch missed it". The causal attribution points at
`gtk+0x65040`, a different function that was never compiled at all. One view
counted where the engine happened to be; the other counts what caused the
work. Acting on the first would have meant debugging a dispatch path that was
working correctly.

### The capture gap, closed and verified

The fix for #31 does not need a sysroot, which this container does not have.
`replay.mjs CAPTURE=<file>` gives the restored engine an assembler and records
every unit it compiles *while the interaction is driven* — capturing the
interactive path directly from the shipped artifact. `EXTRA=<file>` then loads
those units alongside the manifest, so the fix can be verified before anything
is repacked.

| run | units | functions | round-0 interpreted |
|-----|------:|----------:|--------------------:|
| shipped manifest | 7,653 | 13,173 | **13,565** |
| + 9 captured units | 7,662 | 13,187 | **3,023** |

**Nine units — fourteen functions — remove 78% of the first interaction's
interpreted work.** That is the root cause confirmed by repair: the manifest
was missing the interactive path, and adding it is a rounding error on a
7,653-unit pack.

Two honest notes. The wall-clock comparison from these runs is not usable —
the verification run was slower across *every* round (293ms median vs 147ms
baseline), which is machine contention, not the units; the interpreted count is
the clean signal because it does not vary with load. And 3,023 interpreted
steps remain, expected: the capture drove the interaction once, and the call
threshold only compiles a function after four calls, so anything called three
times or fewer during the capture is still uncovered.

### The capture gap cost every stroke, not just the first one

Driving a richer round — click, Escape, and an eight-step pointer drag — over
eight rounds so the four-call tier-up threshold is crossed, then comparing the
shipped manifest against the same manifest plus what that capture recorded:

| | units | functions | round-0 interpreted | steady-state interpreted |
|---|------:|----------:|--------------------:|-------------------------:|
| shipped manifest | 7,653 | 13,173 | **14,360** | **854** |
| + 15 captured units | 7,668 | 13,207 | **3,047** | **92** |

The first-interaction number is the expected win: 79% less interpretation.
The **steady-state** number was not expected and matters more. The baseline
interprets 854 instructions on *every* round, and the captured units cut that
to 92 — so the gap was not only a first-interaction problem, it was costing
every paint stroke, forever, in the shipped product.

Fifteen units, thirty-four functions, 0.2% more manifest. Merged into
`demo/gimp/app.units.gz` and verified by replaying the repacked artifact:
7,668 units, 13,207 functions, round-0 interpreted 3,047, steady 92 — an exact
match for the EXTRA run, so the merge is faithful.

`CFG.sizes.units` in the page is updated to match, though nothing reads it —
only `mem` and `rom` are consumed. Stale shipped metadata is worth fixing
anyway.

Wall clock across these runs stays unusable (contended: the baseline's own
median moved 147 -> 212ms between bursts). Interpreted counts are the signal
here because they do not vary with machine load.

### One click was not the interaction path: the wide script

The fifteen-unit capture above was driven by one click, one Escape and one
drag. That is a single interaction, and the manifest it produced covers a
single interaction. Generalising `replay.mjs`'s round into a `SCRIPT` of
`click:x,y` / `esc` / `drag:x1,y1,x2,y2` steps and driving nine actions
across the tool box, the canvas and two menus shows how narrow the earlier
capture was:

| | units | functions | round-0 interpreted | steady-state interpreted |
|---|------:|----------:|--------------------:|-------------------------:|
| shipped manifest | 7,668 | 13,207 | **240,006** | **225,209** |
| + 142 captured units | 7,810 | 13,487 | **10,468** | **786** |

The shipped manifest — the one that had just been improved to 92 interpreted
instructions per round — interprets **225,209** per round on the wider path.
The single-click round was not representative of it. Steady-state falls
**287x**; round-0 falls 23x.

Note what this says about the earlier "92": it was not the product being
nearly free of interpretation, it was the measurement covering one click.
The number a capture reports is bounded by the script that drove it, and a
narrow script reports a flattering number for a manifest that is only good
at what the script does.

142 units, 280 functions, 1.9% more manifest. Merged and verified by
replaying the repacked directory: 7,810 units, 13,487 functions, round-0
10,468, steady 786 — an exact match for the `EXTRA=` run, so the merge is
faithful. `tools/gui/mergeunits.mjs` does the merge now instead of a
throwaway script.

Wall clock moved 1163 -> 538ms steady on the same contended machine, in the
direction the step counts predict, but the baseline's own rounds spread
+/-27% so that ratio is not a measurement. The step counts are.

### A peephole that was not worth writing

Reading the emitted wasm for the `mem` kernel — ten x86 instructions,
roughly 54 wasm ops — three redundancies are visible by eye: `(i64.add
(i64.const 0) x)` from a zero displacement, `(i64.and x (i64.const
0xFFFFFFFFFFFFFFFF))` from masking a 64-bit result to 64 bits, and
`$fa`/`$fb` flag operands stored for a compare whose only consumer is a
`jne` and needs ZF alone.

Counting them in 148k lines of real emitted WAT before building anything:
1,375 all-ones masks and 210 add-zeros, about 1% of lines. V8 folds all
three away, so they were never a throughput cost; the only real cost was
WAT size, and 1% of it does not pay for the change. Not written.

The `mem` class stays at 4.1x with its cause unlocated. What the dump does
establish is that op count is not obviously the problem: the loop body is
already close to what the x86 says.

### Correction: the 287x was for a page that cannot compile

The comparison above ran `replay.mjs` without an assembler, because the
harness only passed `assembleWat` when capturing. The shipped page is not
like that: it fetches `app.wabt.gz`, sets `eng.assembleWat` and clears
`cacheOnly`, so the default page **can** compile units at runtime. Only
`?nowabt` matches what was measured. `WABT=1` now models the default page,
and re-running both manifests that way:

| round | baseline 7,668 | + 142 units | baseline, no assembler |
|---|---:|---:|---:|
| 0 | 33,520 | 10,391 | 240,006 |
| 1 | 4,361 | 720 | 225,209 |
| 2 | 2,306 | 1,057 | 225,190 |
| 3 | **841** | **1,050** | 225,190 |

With an assembler the baseline **heals itself**: 33,520 -> 4,361 -> 2,306 ->
841, converging on the same steady state as the repacked manifest. So the
142 units do not remove a permanent 225k-per-round cost on the default page.
They remove the *transient*: about 40,200 interpreted steps across the first
three rounds become about 12,200, and the in-page wabt compiles that produced
them do not have to happen.

Both numbers are real, and they are answers to different questions:

- **Default page:** the units buy a head start. Steady state was already
  going to be ~800-1,000 either way; what they remove is the first few
  interactions being slow while the engine tiers up — which is exactly the
  first-interaction latency this was opened to fix.
- **`?nowabt` page:** there is no runtime tiering to fall back on, so
  manifest coverage is the whole story and the units are a permanent 287x.

The earlier commit stated the 225,209 figure without this distinction. It is
the no-assembler number, and reading it as the shipped page's steady state
was wrong.

The profile says where the gap is. Of 239,751 interpreted steps in round 0,
88% (210,992) are in libgtk-x11-2.0.so.0, and 61% arrive through deopt or
callout landings — the top six of which are all marked "never compiled, no
unit covers it". Every one of those six is in the 142-unit capture; the two
hot addresses NOT captured were already in the shipped manifest. The capture
is exactly the gap set, which is the reason it works.

### Where a runtime tier-up spends its time

`tools/gui/cdp_tier.mjs` wraps `tierUpAot` and `assembleWat` in the page and
reports the per-unit split, so the cost of in-browser compilation is a number
rather than an intuition. On the repacked `demo/gimp`:

| | units | sync tier work | emit (compileUnitWat) | assemble (wabt.js) | median | max |
|---|---:|---:|---:|---:|---:|---:|
| File > New > OK | 10 | 109ms | 37ms (35%) | **71ms (65%)** | 2.8ms | **53ms** |
| two paint strokes | 17 | 16ms | 9ms (55%) | 7ms (45%) | 0.3ms | 4.7ms |

Two things fall out.

**wabt.js is the majority of the on-thread cost.** Instantiation is already
off-thread (`asyncCompile`), so what remains on the main thread is emitting
WAT text and parsing it back — and the parse is 65% of that on the menu
path. Emitting wasm binary directly would remove the parse entirely and part
of the emit with it, which makes it the single largest lever on tier-up
latency.

**`tierMsMax` does not bound a unit, only the next one.** The check is
`if (tierMs >= tierMsMax) return` — a pre-check. Once the slice is under
budget a unit of any cost proceeds, so a 53ms unit landed against the 2ms
budget in force during interaction, and 9 of 27 units overshot. 53ms is
three dropped frames.

The exposure is worse than 53ms suggests, because unit sizes are extremely
skewed. Across the shipped manifest's 7,810 units the median is 1,776 bytes
of wasm but the largest is 958,307, and half of all unit bytes live in the
largest 4% of units. The 53ms unit was 0.23 MB of WAT; at the ~230ms/MB
wabt.js rate that implies, a multi-megabyte closure would stall for seconds
— which is the failure the `unitBytes` comment already records as
"30-second pump slices on GIMP's first menu open".

That is the argument for capping unit size against the budget rather than
leaving it unbounded: `unitMaxFuncs`/`unitMaxInsns` exist and truncation is
already sound (calls to skipped functions chain through `$ftr`), but the
page sets neither.

### Capping the unit to the tier budget: built, measured, reverted

The obvious response to "a 53ms unit lands against a 2ms budget" is to cap
the closure at what the budget can pay for. That was implemented — a
self-calibrating cap that tracks observed ms-per-WAT-byte and
WAT-bytes-per-function (measured rather than baked in, since wabt.js in a
page and `wat2wasm` as a subprocess differ by orders of magnitude) and
scales `maxFuncs` down accordingly, with `?nocap` to bisect it. Suite green.

A/B in Chromium, capped vs `?nocap`:

| | units | sync tier work | median | **max** | largest WAT |
|---|---:|---:|---:|---:|---:|
| File>New>OK, capped | 18 | 86ms | 0.3ms | **41.2ms** | 0.23 MB |
| File>New>OK, uncapped | 12 | 98ms | 2.7ms | **42.9ms** | 0.23 MB |
| strokes, capped | 16 | **43ms** | 0.5ms | 12.5ms | 0.11 MB |
| strokes, uncapped | 9 | **9ms** | 0.4ms | 3.7ms | 0.02 MB |

It fails on the thing it was built for. The tail is unchanged — 41.2 vs
42.9ms, and the largest WAT is 0.23 MB in both arms, so the cap never bit on
the worst unit at all. Meanwhile the stroke path got about five times more
expensive, 9ms of sync work becoming 43ms, because splitting closures forces
more units and each one re-pays its fixed costs.

The reason the cap misses is structural: `maxFuncs` bounds how many
functions a closure pulls in, and the expensive units are not wide, they are
*deep* — a few very large functions. Capping the count does nothing to a
single huge one. A cap that worked would have to bound emitted bytes during
emission and stop mid-closure, which the emitter is not built to do.

Reverted rather than left behind an off-by-default flag. The measurement in
the previous section stands; this fix does not, and the honest lever is
still the 65%: emit wasm binary directly and delete the wabt parse.

### Assembling in a worker: 17x less main-thread blocking

wabt.js is a pure text -> bytes transform over no engine state, so it can run
off the main thread. `eng.assembleWatAsync` is that path: `tierUpAot` hands
the text to a worker and finishes in the callback, the same shape
`asyncCompile` already used for instantiation. The page builds the worker
from the wabt source it already fetches, plus the assembler body it shares
with the main-thread version. `?noasmworker` bisects it; if the worker can't
be constructed (a `file://` page, a blocked `blob:` URL) the main-thread
assembler stays and nothing changes.

**The per-unit tier probe could not resolve this, and said so twice in
opposite directions.** Two paired runs of `cdp_tier.mjs`:

| | worker, max unit | main thread, max unit |
|---|---:|---:|
| run 1 | 18.3ms | 40.1ms |
| run 2 | **77.0ms** | 34.1ms |

Run 1 says the worker halves the worst unit; run 2 says it doubles it. The
reason is that every page load compiles a *different* set of units — 10, 15,
19 and 39 across four runs — so the worst unit in one arm and the worst in
the other are not the same work. Comparing them compares unit sets. Emission
also stays on the main thread in both arms, so a 77ms "worker" unit is a
77ms *emit* that the other arm simply never compiled.

`cdp_asmbench.mjs` removes that variance by assembling the **same texts both
ways in the same page**, interleaved, reporting main-thread blocking — the
whole parse for the sync path, the `postMessage` for the worker:

| WAT bytes | sync (parse) | worker (postMessage) | ratio |
|---:|---:|---:|---:|
| 226,880 | 6.4ms | 0.30ms | 21x |
| 94,513 | 2.9ms | 0.20ms | 15x |
| 80,412 | 2.5ms | 0.10ms | 25x |
| 20,665 | 0.9ms | 0.10ms | 9x |
| 17,217 | 0.7ms | 0.10ms | 7x |
| **total** | **17.2ms** | **1.00ms** | **17x** |

This *understates* the win. These are repeat parses of the same text, so
wabt is warm and V8 has already optimised it; the 53ms first-parse measured
earlier is the cost the worker actually removes from a cold path. And the
benefit is not really the median — it is that an unbounded main-thread cost
becomes a bounded one. A multi-megabyte closure used to freeze the tab
(the "30-second pump slices" the `unitBytes` comment records); now it
compiles in the background while the interpreter keeps the app responsive.

Verified functionally in Chromium with the worker on: strokes draw (ink
pixels 0 -> 1,153), units register (7,815-7,820), suite green.

The lesson for the harness: a per-event probe whose *population* changes
between arms cannot measure a per-item effect, however careful the
statistics on top of it are. Fixing the input was worth more than more reps.

### The emitter has no structural waste: two hypotheses, both wrong

With the assembler off-thread, what is left on the main thread is
`compileUnitWat` — 45-55% of tier-up and up to 77ms for a single unit.
Reading it suggested two structural wastes:

1. Emission runs in a retry loop (`for (let round = 0; ; round++)`) that
   calls `texts.clear()` and re-emits **every** non-poisoned function
   whenever any function poisons. A closure that takes several rounds would
   pay several full emissions.
2. Afterwards it decides whether the unit needs the funcref resolver with
   `[...texts.values()].some(t => t.includes('(call $ftr '))` — a substring
   scan over the entire emitted WAT.

`OXWASM_PHASE=1` now attributes analyze, emit, inline and that scan, and
counts emit rounds and re-emits; `replay.mjs` prints the totals, so a capture
run doubles as a fixed-input emitter benchmark (same snapshot, same entry
addresses, every run). Over the wide script's 123 units:

| phase | ms | share |
|---|---:|---:|
| analyze (decode the closure) | 211 | 44% |
| emit (build WAT text) | 262 | 55% |
| inline (off by default) | 0 | 0% |
| ftr scan of all texts | 3 | 1% |
| **total** | **475** | |

9.9M WAT characters over **123 emit rounds for 123 units — 1.00 per unit,
and 0 function re-emits from retries.**

Both hypotheses are wrong. The retry loop never retries on real input, so
its worst case is theoretical; the `$ftr` scan is 1%. Neither is worth
touching.

What remains is intrinsic: decoding x86 and formatting text, split roughly
evenly, averaging 3.9ms per unit. There is no waste to delete here — the
only way to move the 55% is to stop producing text at all and emit wasm
bytes directly, which skips the hex conversions and template formatting that
string building costs. That is now the *correctly sized* case for a binary
emitter: it targets 55% of 475ms of on-thread work, not the wabt parse,
which is already off-thread.

## Breadth: 24 of 25 unmodified system binaries, byte-identical

`tools/breadth.mjs` runs unmodified dynamic PIE binaries from the system and
requires stdout **and** exit status to match running them natively, byte for
byte. Not a speed test — a generality test.

```
ok  wc head sort sort-n uniq grep grep-re sed tr cut base64 md5sum sha256
ok  od seq factor expr printf nl fold paste bc gzip diff
FAIL xz   threw: memory access out of bounds

24/25 unmodified binaries byte-identical to native
```

These are all dynamically linked PIE executables, so every case also
exercises the `ld.so` lane. `gzip -9` reproducing native's 7,815 output bytes
exactly, and `md5sum`/`sha256sum` agreeing, are strong end-to-end checks —
DEFLATE and the hash cores have no tolerance for a single wrong bit.

**Two of the first four "failures" were the harness, and one was a real
engine gap.** Worth recording, because a generality harness that corrupts its
own evidence is worse than none:

- `gzip` was reported as differing *from byte 1*. It was not. The harness
  compared `eng.stdout`, the **string** view, which mangles every non-UTF-8
  byte; `eng.stdoutBytes` holds the raw bytes. Binary output must be compared
  as bytes. The tell was 0xFD replacement characters in the diff.
- `tr` and `bc` produced nothing, which looks like a miscompile. **The engine
  had no stdin at all** — fd 0 was hardcoded to an empty buffer, so every
  filter reading stdin saw immediate EOF. fd 0 was already an ordinary read
  handle over a byte buffer, so this was one line: a `stdin` option that
  fills it. Both pass now, and so does any pipeline filter.

**`xz` is a real bug, and it is not in the AOT.** Run with no assembler at
all, the pure interpreter faults identically: rip `0x553f771`, fault address
`0x21464d88`, after 282,115 instructions — early, during startup, long
before any compression happens. Both tiers failing the same way is the same
signature as the CPython case, and points below both executors at what they
share.

### xz was not a miscompile: brk never failed

`tools/guestfault.mjs` generalises what `gueststack.mjs` did for CPython —
symbol resolution over `eng.maps` plus the main image, an rbp walk, and a
disassembly window taken from guest memory — for any binary. On `xz -9` it
named the fault in one run:

```
fault: 21464d88 @rip 0x553f771 after 281292 interpreted insns
  rip -> libc.so.6+0xac771          (inside _int_malloc)
  regs: rax=1464d70 rbx=20000010 rsi=21464d80 ...
  #0  malloc+0x1a2
  #1  liblzma.so.5  (encoder setup)
  ...
  #6  xz+0xab99
```

The registers say it outright: `rbx = 0x20000010` is the allocation size —
**512MB + 16, on a 512MB guest** — and `rsi` is `rax + 0x20000010`, a chunk
pointer exactly one whole guest region past the block being split. `xz -9`
reserves a dictionary larger than the machine it was given.

Two predictions confirmed it in one run each: `xz -1` at 512MB succeeds
(exit 0, 5,092 bytes), and `xz -9` at 1536MB succeeds (exit 0, 4,392 bytes).
Nothing was miscompiled.

**But the engine had a real bug, one level down.** `mmap` bounds-checks its
range and returns `-ENOMEM`; `brk` did not:

```js
case 12:                                 // brk
  if (a1 > this.brk) this.brk = align(a1, PAGE);
  ret(this.brk); break;                  // any value accepted, echoed back
```

glibc's main arena grows with `brk`. Telling malloc that memory past the end
of the guest region was its to use is why the failure surfaced as a fault
deep inside `_int_malloc` rather than as xz's own allocation error. Linux
answers an unsatisfiable `brk` by returning the break **unchanged**, which is
how glibc's `sbrk` detects failure. With that fixed, `xz -9` on a 512MB guest
exits 1 cleanly, like native out of memory, and with room it compresses
byte-identically.

Only the end of guest RAM is enforced. The heap can still in principle grow
into the mmap region 64MB above it — a separate pre-existing overlap, left
alone because capping `brk` at `mmapBase` would limit every guest's heap to
64MB.

Breadth is now **26/26**, with `xz -9` and `xz -1` both byte-identical.

Nothing else moved. GIMP's wide-script replay is unchanged after the fix
(round interp 10,468 / 786 / 767, an exact match), and CPython still faults
the same way at the same place (`0x5241f5`, 15.26M instructions, 3 bytes of
stdout — "42\n"), so #35 is a genuinely separate bug and not another
unbacked-heap symptom.

### CPython: the mechanism, finally named

`guestfault.mjs` grew what the parked note said it needed — all 16 registers,
`DUMP=` for memory around an address, and `WATCH=addr,len` on the engine's
existing write-watchpoint (forcing `OXWASM_NOBULK=1`, since the `rep
movs`/`stos` fast paths bypass `Memory.write` and would hide a bulk copy over
the watched word).

**The faulting instruction, exactly.** `testb $0x40,0xa9(%rax)` with
`rax = 6` — address `0xaf`, matching the reported fault. `0xa8` is `tp_flags`
and bit 14 is `Py_TPFLAGS_HAVE_GC`, so this reads `obj->ob_type` and gets the
integer 6. The enclosing loop, disassembled from the binary at its true
address:

```
5241c4:  mov    -0x8(%r13),%rax      ; _gc_prev
5241c8:  test   $0x2,%al             ; _PyGC_PREV_MASK_COLLECTING
5241cc:  sub    $0x4,%rax            ; gc_decref: gc_refs live above _PyGC_PREV_SHIFT=2
5241d0:  mov    %rax,-0x8(%r13)
5241d4:  add    $0x1,%rbx            ; i++
5241d8:  add    $0x10,%r12           ; entry += 16  (PyDictUnicodeEntry)
5241e1:  mov    (%r12),%r13          ; obj = entry->key
5241ea:  mov    0x8(%r13),%rax       ; obj->ob_type
5241ee:  testb  $0x40,0xa9(%rax)     ; Py_TPFLAGS_HAVE_GC
```

`PyObject_GC_Del+0x20b5` — the GC's `subtract_refs` pass walking a dict.

**The write history settles what happened.** Watching
`[0x1b29280, 0x1b29290)` across the whole run, 23 writes:

```
@14592725  +8  <- 0x9284e0    (ob_type set: object created)
@14592731  +0  <- 1           (refcount 1)
           ... 2, 1, 2, 3, 2, 1 ...
@14655717  +0  <- 0           refcount reaches ZERO
@14655900  16B <- free-list   libc free() writes its links
@14664677  16B <- 0           the block is REUSED
@14667529  +0  <- 0x5efb4b0
@15258914  +8  <- 6           written by THIS gc pass, from 0x5241d0
```

So: the object is freed at 14.65M instructions, the block is reallocated at
14.66M, and at 15.26M the GC walks a dict that **still holds a pointer to
it**. The 6 it reads as `ob_type` is a `gc_prev` word this very loop wrote on
an earlier iteration, for the object now living 16 bytes higher. A textbook
use-after-free, from a refcount that reached zero while a dict still
referenced the object.

That is the mechanism, which was not known before. What is still not known is
**which** of the eight refcount writes is the wrong one — that needs a
reference execution to diff against, so the reopen condition in the original
note stands, now with the exact addresses and rips to diff.

**Two tool bugs found and fixed on the way, both of the same family.**
Disassembling a window from `rip-48` out of guest memory starts mid-instruction:
it rendered `5241c4 mov -0x8(%r13),%rax` as `5241c5 mov -0x8(%rbp),%eax`, a
32-bit load from a different register, which would have supported an entirely
wrong story. And `locate()` subtracted the load base unconditionally, but
python3 is **ET_EXEC** — non-PIE, loaded at its own vaddrs with bias 0 — so
every text address came out ~1.2MB low and resolved to nothing, while heap
addresses landed inside the binary and were labelled `python3+0x1728230
(_end+0xc8eb10)`. A symbol offset past the end of the file is the tell, and
this is the third time in these notes that assuming an address belongs to the
main image has produced a confident wrong answer.

### CPython, sharper: the dict is alive, and one symbol name was not trustworthy

Two checks this round, one of which refuted a hypothesis of mine.

**The dict is not the corrupt thing.** It was worth asking whether the whole
story was one use-after-free of the *dict* rather than of the string — a
freed dict would explain a stale key pointer without any refcount bug. It is
not: at fault time the dict at `r15` reads

```
+0   0x1              ob_refcnt = 1
+8   0x91e340         ob_type = PyDict_Type exactly
+16  0x4              ma_used
+32  0x5ebde30        ma_keys
```

A live, correctly typed dict. Its entries are 16-byte `PyDictUnicodeEntry`
`{key, value}` pairs (the neighbouring values point into `_PyRuntime`, i.e.
static objects), and `r14 = 5` is `dk_nentries`. So a **live** dict holds a
key pointer to a freed string — which strengthens the premature-free
conclusion rather than replacing it.

**And a correction to the previous entry.** It named the faulting loop
`PyObject_GC_Del+0x20b5`. That offset is 8,373 bytes past the symbol, and
python3 is stripped to 1,699 dynamic symbols for 2.7MB of text, so "nearest
preceding symbol" there is almost certainly a different function. The loop is
in the GC's reference-subtraction pass — the `sub $0x4` on `_gc_prev` and the
`Py_TPFLAGS_HAVE_GC` test say that much — but it should not have been given a
name. The same applies to the `_Py_CheckFunctionResult+0x9e0` and `+0xf9`
attributions of two decrefs.

`locate()` now refuses to guess: past 4KB from the nearest symbol it prints
`(>4096B past <sym> - name unreliable)` instead of a confident offset. Close
symbols still resolve normally (`_exit+0x1d`), and a stripped binary's own
frames come back as a bare `xz+0x54bc` rather than an invented name.

The refcount rips whose symbols ARE close enough to trust:

| | rip | symbol | instruction |
|---|---|---|---|
| create, refcnt=1 | 0x516060 | `PyUnicode_FromString+0x130` | `movq $0x1,(%r15)` |
| ->2 | 0x51f342 | `PyDict_SetItem+0x32` | `addq $0x1,(%rdx)` |
| ->2, ->3 | 0x52e5e1 | `PyDict_Copy+0x181` | `addq $0x1,(%rdx)` |

So the dict took its reference through `PyDict_SetItem`, and the string was
later freed anyway. Four increfs, four decrefs, and a live dict still
pointing at the corpse: one of the four decrefs released a reference it did
not own. Which one still needs a native reference execution to diff against —
gdb is available, but matching "the same object" across two heaps is the part
that has to be built.

### CPython: the object has a name — `_pyio.IOBase.__doc__`

Identifying *which* object dies is what a native reference run needs, since
addresses will not match across two heaps. `WATCHSTR=1` now dumps the
`PyASCIIObject` header — length at `+0x10`, state at `+0x20`, payload at
`+0x28` — at every watched write, and that names it:

```
@14603146  refcnt<-1   PyUnicode_FromString+0x130   len=<uninitialised>
@14604658  refcnt<-2   PyDict_SetItem+0x32          len=1235 "…The abstract"
@14604817  refcnt<-1   (eval loop)                  len=1235 "…The abstract"
@14607803  refcnt<-2   PyDict_Copy+0x181            len=1235 "…The abstract"
@14658820  refcnt<-3   PyDict_Copy+0x181            len=1235 "…The abstract"
@14659132  refcnt<-2   …                            len=1235 "…The abstract"
@14665071  refcnt<-1   …                            len=1235 "…The abstract"
@14666480  refcnt<-0   …                            FREED
```

A 1,235-character string beginning `"The abstract"`. Searching the stdlib for
a docstring with that prefix gives exactly one match:
`/usr/lib/python3.11/_pyio.py`, the `IOBase` class docstring — *"The abstract
base class for all I/O classes."* (1,239 characters in source; the small
difference is where the payload starts for a non-compact string, and the
prefix match is unique.)

So the dying object is **`_pyio.IOBase.__doc__`**, and the live dict still
pointing at it is `IOBase.__dict__`. That also explains the shape of the
trace: `PyDict_SetItem` puts `__doc__` into the class dict, and the two
`PyDict_Copy` increfs are the type machinery copying that dict.

Reading the header rather than the characters alone was necessary. At the
creation write the object is not yet initialised — the payload there is still
the previous occupant's bytes (`\x93\x01d=d>…`, which looks like bytecode and
would have sent this somewhere wrong), and the length field is garbage. Only
from `PyDict_SetItem` onward does the object read as itself.

This is the handle the native reference run needs: break when a string of
that length and prefix is created, watch its refcount, and diff the rip
sequence against the eight writes above. python3 is `ET_EXEC`, so its text
addresses are identical under gdb — the rips transfer directly.

## The bug: `movhlps` moved the wrong half

`tools/pyref.gdb.py` runs the same python3 natively under gdb, identifies the
object by what it *is* rather than where it lives, and logs the same refcount
sequence. Two passes: pass 1 conditions on `PyDict_SetItem+0x32` with
`*(long*)($rdx+0x10) == 1235` to find the address, pass 2 re-runs watching
that address from the creation site so the log covers the whole life. gdb
disables ASLR and python3 is `ET_EXEC`, so both the object address and every
text rip are stable and directly comparable.

**The identity condition matched two objects**, not one — checking that
mattered, because diffing against the wrong one showed a bogus divergence at
the very first write. The second object is the counterpart:

| # | native | engine |
|---|---|---|
| create | 1 | 1 |
| 1 | →2 at `0x51f342` | →2 at `0x51f342` |
| 2 | →1 at `0x5408d5` | →1 at `0x5408d5` |
| 3 | →2 at `0x52e5e1` | →2 at `0x52e5e1` |
| 4 | →3 at `0x52e5e1` | →3 at `0x52e5e1` |
| 5 | →2 at `0x52d4a0` | →2 at `0x52d4a0` |
| 6 | **→3 at `0x56530c`** | **absent** |
| 7 | →2 at `0x52cbb9` | →1 at `0x52cbb9` |
| 8 | →1 at `0x52d4a0` | →**0**, freed |
| 9 | →0 at `0x52d75d` | — |

One missing incref. A watchpoint reports `$pc` after the store, so write 6 is
`addq $0x1,(%rcx)` at `0x565308`, and `%rcx` comes from:

```
5652da:  movhlps %xmm0,%xmm1      ; xmm1[63:0] <- xmm0[127:64]
5652dd:  movq    %xmm0,%rsi
5652e2:  movq    %xmm1,%rcx
...
565304:  addq    $0x1,(%rsi)      ; incref the first of a returned pair
565308:  addq    $0x1,(%rcx)      ; incref the second   <-- landed elsewhere
```

**`0F 12 /r` is two instructions.** With a memory operand it is
`movlps`/`movlpd` — load the low qword. With a *register* operand it is
`MOVHLPS`, whose entire purpose is the other half: `dst[63:0] = src[127:64]`.
Both tiers implemented it as "take the low qword" regardless of operand kind:

```js
// interp.mjs
case 0x12: this.xmm[insn.xr] = (this.xmm[insn.xr] & ~MASK64) | rdRm(8);
// aot_wat.mjs
case 0x12: put(`(i64x2.replace_lane 0 ${dst} ${rm.kind==='xmm'?xlo(rm,next):…})`);
```

So wherever gcc uses `movhlps` to unpack a pair returned in one xmm — here two
object pointers about to be increfed — the second pointer was wrong, the
incref landed on an unrelated address, and a live object was freed early.
`0F 16` (`movlhps`) was already correct, which is why only one half of the
pattern broke. Fixed in both tiers.

**CPython 3.11 now runs to completion in the interpreter**: `exit=0`, "42" on
stdout, 20.7M instructions, no fault. It previously died at 15.3M.

**The regression test would have caught it, and now does.**
`engine/diff/packedtest.mjs` checks register-form SSE ops against the real CPU
via `./stepper`, and `movhlps`/`movlhps` were simply not in its list. Added:
591/591 bit-exact with the fix; reverting the fix gives exactly 2 mismatches,
and the values name the bug — `hw=8e8f8c8d8a8b8889` (the high qword) against
`interp=8687848582838081` (the low one). A regression test that does not fail
on the old code is worth nothing, so that was checked rather than assumed.

Suite green, breadth still 26/26.

**A separate AOT bug remains, and it is not this one.** With the AOT tier live
CPython fails much earlier, at ~560k instructions, with
`SystemError: Negative size passed to PyUnicode_New` from
`_install_external_importers`. Running it with the fix and with the fix
reverted gives the same failure at 559,918 and 560,126 instructions — so this
is pre-existing and unrelated. It was invisible until `guestfault.mjs` started
printing the guest's **stderr**: the exit code and fault address alone said
only "exit 1, no output".

### The AOT-only CPython failure: narrowed, not solved

`tools/unitbisect.mjs` compiles only the first N translation units and
interprets the rest, then binary searches N for the smallest value that
reproduces a failure. This is how unit 134 was named for the earlier crash;
it is a tool now because a second AOT-only failure needed the same search.

The predicate matters: a run is GOOD only when the guest exits 0 with nothing
error-shaped on stderr. An AOT bug that makes the guest raise its *own*
exception exits non-zero with no fault at all, so a crash-only predicate
would have called this one good.

```
all units   BAD   exit=1 stdout=0B units=337
no units    GOOD  exit=0 stdout=3B units=2131
bisecting over 337 units...
  cap=326   GOOD      cap=327   BAD
unit 327 is the culprit (unit 326 is clean)
  entry rip 0x5ccce80  =  libc+0xbae80
```

That entry is inside libc's contiguous string-function block, and the code
there is a reverse string search — `movups` / `pcmpeqb` / `pmovmskb` / `bsr`,
with `bsr %eax,%eax` immediately followed by `je`. A wrong result from any of
those gives a wrong string length, which is exactly the shape of
`SystemError: Negative size passed to PyUnicode_New`.

**`bsr` looks correct on inspection, so it stays a suspect rather than a
conclusion.** The AOT stores the *source* into `$fr` before writing the
destination and derives ZF from `$fr == 0`, which is the architectural
behaviour (ZF ← src == 0, destination undefined when src is zero), and it is
correct even for `bsr %eax,%eax` where destination and source are the same
register.

The engine's lockstep differential — `eng.shadowLib`, which runs each
compiled dispatch into a named library both ways, interpreter first with a
memory journal, and reports the first register or memory divergence — is now
reachable as `SHADOW=libc.so.6` in `guestfault.mjs`. It reports **no
divergence** on this run. So either the miscompiled function is not the
unit's entry (a unit is a whole call closure, and only the entry was named by
the bisect), or it is one the shadow declines to compare — the shadow aborts
on any syscall and requires a clean return to the caller.

Narrowing to a single unit is real progress from "CPython fails under AOT",
but the faulty instruction is not identified, so nothing is claimed fixed.
The next step is to shadow python3 rather than libc, and to list unit 327's
functions so the closure can be searched rather than its entry assumed.

### SSE coverage: the gap class that hid `movhlps`

`movhlps` was wrong for the life of the project because `packedtest.mjs`
never listed it. Auditing what else the interpreter implements but the
hardware differential never exercises turned up three more groups, now added:

- **`andps`/`andnps`/`orps`/`xorps`** and their `pd` forms. These are
  *separate opcodes* (`0F 54`-`57`) from the integer `pand`/`pandn`/`por`/
  `pxor` (`0F DB`/`DF`/`EB`/`EF`) that were already tested, so covering one
  said nothing about the other — and `andnps` has the same "which side gets
  inverted" trap as `pandn`.
- **`shufps`/`shufpd`**, which select lanes from *both* operands and are a
  different shape from the `pshuf*` family already covered.
- **`movmskps`/`movmskpd`**, alongside the `pmovmskb` that was tested.

591 cases became **685, all bit-exact against the real CPU**. No new bugs —
but the class of silence that hid `movhlps` is closed, which was the point.

### Unit numbers are not a stable identifier (and one function is enough)

Compiling *only* unit 327 produced a one-function closure at `0x51fbe7` in
python3 — where the capped bisect had reported `libc+0xbae80`. Two different
functions under the same number, because which functions get hot, and in what
order, depends on what is already compiled.

So `unitbisect.mjs` now bisects over **entry addresses**: record the order in
which entries are offered for compilation in a full run, then binary search a
prefix of that address list. An address means the same thing in every
configuration. The re-bisect **confirms the earlier answer** — culprit entry
`0x5ccce80` = `libc+0xbae80` — so the published claim stands; only the
select-by-number experiment was invalid.

`ADDR=0x5ccce80` then gives a **minimal reproducer: compiling that single
function, with everything else interpreted, is enough to break CPython.** Its
closure is one function.

### A differential that never looked, and then looked and found nothing

The lockstep shadow reported no divergence, which could mean two very
different things. Every bail inside `shadowDispatch` is silent — a syscall,
the 5M-step cap, or an exit that is not a clean return — so a run that
compared *nothing* looked exactly like a run that compared everything and
found nothing. That is the worst failure mode a differential can have, so it
now counts what it did:

```
shadow: tried=681 compared=681 aborted=0 diverged=0
```

It genuinely compared all 681 entries. Two gaps were closed on the way:
`shadowMax` (the exoneration cap was a hardcoded 50 clean passes, useless for
a libc routine called hundreds of times), and the comparison itself, which
saved flags and the fs base only to *restore* entry state and never compared
them — a unit returning the right registers and the wrong flags looked clean.

With flags and `fsBase` compared and the cap lifted: still **681 compared, 0
diverged**.

So the defect is *not* in that function's observable effect at its entry
boundary — not registers, xmm, flags, fs base, or journaled memory, on any of
681 calls — and yet compiling it alone breaks the program. That is a real
narrowing, and it rules out the obvious shape of the bug.

What remains, testable next:

- **Bulk writes are outside the journal.** `rep movs`/`stos` go through
  `mem.view()` and `TypedArray.set` in the interpreter, and the AOT emits
  `memory.copy` — neither goes through `Memory.write`, so neither is
  journaled. A memory difference from a bulk operation is invisible to the
  comparison *and* to the undo. `OXWASM_NOBULK=1` during shadowing would
  settle it.
- **Entry elsewhere than the entry point.** Only dispatches at the registered
  entry are shadowed; a tail-jump into the body would not be.

Nothing is claimed fixed. The previous entry's guess that the bad function
was "elsewhere in unit 327's closure" is wrong: the closure is one function,
and it compares clean.

### Localizing without a theory: diff the syscall traces

The shadow said the function behaves identically on all 681 entries, yet
compiling it alone breaks the program — a contradiction that no amount of
further staring at the disassembly was going to resolve. So instead of
another hypothesis about *why*, `SYSLOG=<file>` records every syscall (number
plus the four register arguments) in order, and the two configurations get
diffed. The first differing line is the first guest-visible consequence of
the miscompile, whatever caused it.

Filtering `clock_gettime` (timing-dependent, and not evidence), the traces
are **identical through syscall 86** — the same `newfstatat` — and then:

```
GOOD (interpreted)              BAD (that one function compiled)
201 0 0 8            time()     9 0 ff6a8000 3 22     mmap(NULL, 0xff6a8000, RW, ANON)
257 ffffff9c 5ddea27 openat()   12 1011c1000 ...      brk(0x1011c1000)
12 1b41000 ...       brk()      9 0 ff6c8000 3 22     mmap(NULL, ~4GB, ...)
                                1 2 a314d0 ...        write(2, ...)   <- the traceback
```

The bad run asks for **0xff6a8000 bytes — 4,285,464,576**. As a signed 32-bit
value that is **−9,928,704**: a negative length reinterpreted as a huge
unsigned one, which is precisely the shape of `Negative size passed to
PyUnicode_New`. The wrong value is a *size*, and the function is a reverse
string search, so a returned pointer below the start would make the caller's
`p - start` negative. That is a concrete mechanism, and it is now pinned to a
single program point rather than inferred.

It also sharpens the contradiction usefully. The shadow compared 681 entries
at `0x5ccce80` and found none wrong, so **the failing call is not among
them** — the function must be reached by a path that never goes through
`dispatchMaybeShadow`. The candidate is the in-wasm `$ftr`/`drive` chain:
once execution is inside compiled code, a guest call or tail-jump to an
address in the funcref table dispatches in wasm without returning to JS, and
the shadow only sees JS-side dispatches. Counting actual entries to that rip
against the 681 shadow attempts would confirm it, and is the next step.

### The call site, named: `str.rpartition` in importlib's path handling

`BIGMMAP=<bytes>` traps the moment the guest asks `mmap` for more than a
threshold and walks the guest stack right there. A wrong *length* is computed
by the caller, not by the string routine that returned a bad pointer, so the
frame chain at the allocation names the code that actually went wrong — which
a faulting address never does:

```
*** mmap(len=0xff6a8000 = -9797632 as i32) at mmap64+0x2c
    #2 malloc+0x1a2
    #3 _PyUnicode_FromASCII+0x172
    #4 PyUnicode_RPartition+0x16c
    #5 _PyObject_Call_Prepend ... #11 PyImport_ImportModuleLevelObject+0x8a4
```

`PyUnicode_RPartition` — `str.rpartition` — is a **reverse** partition, and
the compiled function at `0x5ccce80` is a reverse string search. The chain is
therefore: rpartition asks for the last occurrence of a separator, the
compiled search returns a pointer below the start of the string, and
`_PyUnicode_FromASCII` is handed `p - start` as a negative length.

`str.rpartition` is not in the test program. Running
`print('a/b/c'.rpartition('/'))`, `'hello world'.rsplit(' ')` and a plain
string concatenation all fail **identically**, at the same
`_install_external_importers` frame and within 13k instructions of each
other — the rpartition is importlib's own path splitting during startup, so
there is no smaller Python-level reproducer. The minimal reproducer stays the
one at the engine level: compile that single function and CPython cannot
import.

What is still unexplained is the contradiction with the shadow, which
compared 681 entries to that function and found register, xmm, flag, fs-base
and journaled-memory equality every time. Either the failing call is not
among those 681, or the difference is in something none of those cover. The
next experiment does not go through `shadowDispatch` at all: log
`(rdi, rsi, rdx) -> rax` on every dispatch of `0x5ccce80` in the compiled run
and compare against the same call sequence interpreted. That answers "does
this function ever return the wrong thing" directly, without depending on the
machinery whose blind spots are the open question.

## The AOT CPython bug: `bsr` clobbered a destination hardware preserves

The chase ended one layer deeper than every probe so far, and the probes'
blind spots were half the story.

**Resolving the shadow contradiction.** The lockstep shadow compared 681
entries of the culprit function and found them identical — while the failing
call never went through it. Three dispatch paths execute a compiled
function's wasm without touching `dispatchAot`: the PLT-stub wasm's `$ftr`
tail-call chain, the JS-closure stub's direct `cachedFn()`, and the
deopt/callout chains. The shadow and every rip-keyed probe watched the JS
boundary; the actual traffic flowed in-wasm through the stubs. The chain of
eliminations that proved it: `NOFTAB` (empty funcref table) still failed;
compile-but-`DISCARD` passed; `CHAINSLOW` still failed; and wrapping the
registered export (`REGWRAP`) caught **one call** once `NOFTAB` forced all
traffic through the JS map:

```
BAD rdi=0x958870 rsi=0x2e rdx=0x1a -> rax=0xffffffff expected 0x0
```

Twenty-six bytes searched backwards for `'.'` — importlib splitting a dotted
module name — with **no dot present**. Correct answer: NULL. Compiled
answer: `0xffffffff`. And `0xffffffff - 0x958870 = 0xff6a778f`, the exact
neighbourhood of the 4GB mmap.

**The bug.** Intel documents `bsf`/`bsr`'s destination as undefined when the
source is zero; real Intel and AMD silicon leave it **unmodified**, and
glibc's hand-written string asm depends on that: `__memrchr` ends its scan
with `bsr %eax,%eax; je ret`, returning the untouched rax as its not-found
NULL. The interpreter already guarded the write (`if (v !== 0n)`); the AOT
emitted `31 - clz(0) = -1` unconditionally. One tier preserved the register,
the other wrote `0xffffffff` into it — which is why CPython imported cleanly
interpreted and could not import compiled.

Fixed by skipping the write entirely when the source is zero, preserving the
full 64-bit destination exactly as the silicon does. The rewrite incidentally
fixed a second latent bug the regression test then surfaced on old code:
16-bit `bsr` scanned the full 32-bit register and could report a bit above
bit 15 (`0x1f` where hardware says `0xf`).

**Regression test** (`engine/diff/bsrtest.mjs`, in the suite): part 1 pins
the silicon behaviour itself via `./stepper` — including zero-source
destination preservation, which the manuals refuse to promise — 36/36; part
2 pins AOT == interpreter on the same cases, 36/36 with the fix and 23/36
without it.

**Result: CPython 3.11 runs end-to-end in BOTH tiers.** Full AOT: exit 0,
"42" on stdout, 2,265 compiled functions, 897k interpreted instructions —
against 20.7M interpreted in the pure-interpreter run, so the compiled tier
is carrying the run. Suite green, breadth 26/26.

Two morals worth keeping. Every differential in this engine compares what
its author thought the boundary was — the shadow's boundary was JS dispatch,
and three busier doorways bypassed it; instrumentation now counts what it
did NOT compare. And "architecturally undefined" is not "unused": real
software is written against what the silicon does.
