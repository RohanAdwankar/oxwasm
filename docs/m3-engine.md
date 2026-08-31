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
