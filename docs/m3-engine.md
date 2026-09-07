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
| inline (off at the time; default-on since) | 0 | 0% |
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

## Breadth: 31/31, with CPython, perl, openssl and a shell script in the sweep

With both silicon-semantics bugs fixed, the sweep grew the binaries most
likely to keep them honest:

- **python3** `-S -c` with the full stdlib tree, runs the two-tier pipeline
  that took `movhlps` and `bsr` to make work. It stays in the sweep so
  neither can regress silently. 2,315 compiled functions, byte-identical.
- **perl** — which found the next gap immediately: it opens `/dev/null`
  during startup and exits 2 when it cannot, and the engine had no
  `/dev/null`. (Printing guest stderr made this a one-line diagnosis:
  "Can't open /dev/null".) Added as a device in `openat`: empty backing
  bytes make read (EOF), fstat and lseek behave through the ordinary file
  paths, and write gets a one-line discard case. Not a miscompile — a
  filesystem hole.
- **openssl** `dgst -sha256` and `enc -base64`, and **sh** with a loop.

`tree:` is now a per-case option (an interpreter is not one file; without
its stdlib CPython would measure its own startup failure).

**31/31 unmodified binaries byte-identical to native**, suite green.

## The `mem` 4.1x was mostly V8's Liftoff tier, not the translation

`bench/kernels/idealmem.mjs` runs the same loop three ways, interleaved:
native (the kernels binary, two iteration counts so startup cancels), a
hand-written WAT in the **emitter's exact shape** — all state in i64 locals,
address = wrap(base + (i<<3)) + negative constant, lazy-flag compare at the
back edge — and an **idiomatic** WAT (i32 index, offset immediate). The
result contradicted the standing 4.1x outright:

| arm | steady 30M iters | vs native |
|---|---:|---:|
| native | 21.9ms | — |
| faithful (emitter shape) | 20.6ms | **0.94x** |
| ideal | 19.8ms | 0.90x |

The emitter's code shape costs ~4% against ideal and runs at parity with
native — while the engine, running a unit whose loop body is line-for-line
identical (checked by dumping it again; the only deltas are two constants V8
folds), measured 2.71x the same day. The counters say the gap is *inside*
the wasm: interp/deopt/dispatch counts are identical between the two
iteration counts, so the extra 30M iterations run entirely in compiled code.

The difference between the two contexts is **which V8 tier executes the
loop**. The engine enters a unit a handful of times and each entry loops for
millions of iterations — a shape that never earns call-count tier-up, so the
hot loop runs in Liftoff. The standalone module was warmed by whole calls
into TurboFan. Both directions flip on command:

- engine under `node --no-liftoff`: **2.71x → 1.66x**
- faithful/ideal under `node --liftoff-only`: **0.94x/0.90x → 3.32x/2.73x**,
  reproducing the engine's gap exactly.

So for straight-line memory streaming, the translation itself is at parity
(loop body, TurboFan) to 1.66x (whole engine, TurboFan); the rest of the
observed 2.7-4.1x is Liftoff occupancy. V8's dynamic tiering did not rescue
the loop within a 30M-iteration run in node 22 — whatever back-edge budget
exists, the measured steady state stayed at Liftoff speed.

What this means for #26: the emitter is no longer the main residual for
straight-line code, and "rewrite the translator" is even less justified than
the call-tax finding already made it. The remaining levers are the call tax
(9.5x, fixed per call) and **tier occupancy** — getting the VM to run hot
units in its top tier. On the product side the candidate is compiled-module
caching across visits (Chrome preserves TurboFan code for structured-cloned
`WebAssembly.Module`s in IndexedDB), which the page's existing IndexedDB
unit store could carry; that is a follow-up, not a claim.

### The tier question, answered on the product platform

`tools/gui/tierprobe/` runs the emitter-shaped loop in real Chromium: a cold
visit and a reload in one profile, six timed calls of `run(30M)` each.

```
cold  : compile 10.7ms  runs [70.2, 14.6, 16.6, 16.3, 14.5, 14.7]
reload: compile  4.5ms  runs [15.8, 14.4, 14.5, 16.9, 16.9, 17.9]
```

**Chrome tiers a wasm function after one call.** The first call runs its 30M
iterations in Liftoff (~3.5x); every later call is top-tier. No OSR rescues
a first call mid-loop, in Chrome or node. **And a reload starts top-tier
from call 1** — same-URL `compileStreaming` hits Chrome's implicit code
cache (`serve.mjs` now sends `application/wasm`, which that API requires).

This also dissolves the node/engine discrepancy: the kernels harness calls
`k_mem` **once** per process, so its only call is the Liftoff call — the
4.1x row measured the pathological once-called shape, and node's dynamic
tiering never got a second call to act on. Real programs re-enter their hot
functions, get top-tier code from the second call on, and their exposure is
one Liftoff pass per function — the same first-use transient the capture
work already targets — not a permanent multiple.

The remaining shippable lever is the reload path: the page compiles units
from bytes out of `app.units.gz`, and buffer compiles get no implicit code
cache. Serving units as streamed same-URL `.wasm` would start repeat visits
top-tier, at the cost of a packaging change. Follow-up, with the measurement
above as its justification.

### Dirty-rect compositing: measured, refuted as a latency lever

`tools/gui/cdp_flushcost.mjs` wraps `xs.flush` (with a full framebuffer diff
against the previous frame) and `putImageData` in the live page, then drives
a menu open and strokes. On the File>New>OK sequence, 18 flushes:

```
flush (full recomposite of the window tree)  med 0.7ms  max 1.9ms
putImageData (full 1024x768 canvas)          med 0.4ms  max 0.5ms
damage: ~13% of the screen per frame (bbox and changed-pixel count agree)
```

A complete paint — clear, recomposite every window, blit the whole canvas —
costs about **1.1ms**, against an input-to-paint median of ~40ms. Dirty-rect
compositing would cut that to perhaps 0.2ms: under 3% of the frame. It is
not a latency lever, which also agrees with the earlier rAF finding that the
stroke latency is wait-dominated, not work-dominated. Parked as at most a
battery nicety; the task is closed as refuted by measurement rather than
implemented.

Caveat kept honest: the probe's stroke phase recorded zero flushes — the
strokes almost certainly landed on no open image, so the stroke-path flush
cadence went unmeasured here. The conclusion stands on the menu data, since
a flush recomposites everything regardless of what changed, making its cost
shape-independent.

### The full kernel table under the top tier: straight-line parity

The `--no-liftoff` table was reported abandoned when its 66-minute timeout
expired — wrongly: the harness buffers output until it exits, and the
completed table was sitting in the pipe. It is the definitive version of the
per-class picture (N auto-calibrated per kernel, up to 52 *billion*
iterations for `alu`, reps interleaved, startup under 11% everywhere):

| kernel | default tiers | TurboFan forced | spread |
|---|---:|---:|---:|
| alu | 2.7x | **0.87x** | ±4% |
| mem | 4.1x | **1.01x** | ±9% |
| subw | 3.4x | **1.07x** | ±4% |
| branch | 1.8x | **1.07x** | ±4% |
| muldiv | 1.6x | **1.02x** | ±5% |
| call | 9.5x | **6.37x** | ±3% |

**Every straight-line class runs at native parity under the top tier** —
`alu` measurably faster than the gcc -O2 binary. The whole 1.6–4.1x
straight-line gap in the standing table was Liftoff occupancy, and per the
Chromium probe, top-tier code is what real programs get from the second call
of each function onward. The one remaining gap with a mechanism of its own
is the call tax: 6.37x even in TurboFan, consistent with the earlier finding
that it is a fixed ~22-instruction charge per call.

Against the project's goal — run unmodified binaries at native speed in wasm
— this is the strongest statement the kernels can make: the translation, in
the tier the platform gives hot code, is not the bottleneck anywhere but
calls.

### Decomposing the call tax: the platform floor is 2x, the protocol doubles it

Both prior hypotheses died measured (funcref table; caller spill narrowing on
a 4%-resolution harness). `bench/kernels/idealcall.mjs` measures what was
never isolated — the call machinery itself — with five interleaved arms of
the same k_call loop (`s += leaf(i) ^ leaf(s)`), every wasm callee carrying a
never-taken branch of dead stores so V8's inliner cannot fold it away:

| arm | 10M calls | vs native |
|---|---:|---:|
| native | 12.4ms | — |
| plain (wasm param/result call) | 25.7ms | **2.08x** |
| + stack-budget check per call | 23.5ms | 1.90x |
| args through regfile slots | 23.1ms | 1.87x |
| faithful (full spill protocol) | 43.8ms | **3.54x** |

Three conclusions, sized against spreads of ±17–61%:

1. **A bare non-inlined wasm call costs 2x native.** That is the platform
   floor; no calling-convention change can beat it. It is also why opt-in
   inlining measured 6–11% on real call-dense programs — inlining is the
   only mechanism that removes the floor itself.
2. **The budget check and memory-slot argument passing are free** within
   noise — well-predicted branch, store-forwarded slots. Counting emitted
   ops has now mispredicted three times.
3. **The full protocol roughly doubles the floor** (3.54x): the part that
   costs is the bulk regfile load/store at callee entry/exit plus the wide
   caller spill, not any single component small experiments could see. The
   engine's measured 6.4–8x still exceeds this reconstruction — the prime
   suspect for the remainder is the xmm half of spillAll ("every touched
   register plus all xmm"), which this model omits, plus real units' frame
   size.

The strategic consequence: straight-line code is at parity, calls are
floored at 2x by V8 itself, so the remaining call-tax levers are (a)
narrowing the *callee-side* protocol for direct in-unit calls — never
tested; the dead experiment narrowed only the caller — and (b) promoting
inlining from opt-in, whose main objection (+116ms tier-up, 55ms of it
emission) is halved now that assembly runs off the main thread. Both are
measurable next steps, not claims.

### Inlining promoted to default-on

Lever (b) was taken. The gate, all with inlining forced on:

- **Full suite green** (hardware differentials, decode lengths, engine
  tests — `set -e`, ends at decodetest: 21,410 lengths exact, 0 wrong).
- **Breadth 31/31 byte-identical** to native, including two-tier CPython
  (124s) and openssl.
- **Browser A/B on the packed GIMP page**, interleaved `?inline` vs
  default, warm-stroke input→paint medians over clean reps: default
  ≈32.5ms (32.1/32.6/32.4/33.8), inline ≈30.3ms (30.3/29.0/39.4) —
  parity to slight win; the stroke path is not call-dense enough to show
  the 6–11%. Sync tier work for File>New: 132ms vs 121ms (+9%, absorbed
  by the async pipeline).

One run per arm failed with a shared, arm-independent signature — the
probe's ink region non-empty *before* any stroke, zero paints, then a
multi-second catch-up — including a **default-arm** failure (ink 3522→0),
which exonerates inlining: it is a page-load/window-placement flake under
box contention, worth its own investigation, not a miscompile.

`inlineEnabled` now defaults to true; opt out with `OXWASM_INLINE=0` or
`globalThis.__inline = false` (page lever `?noinline`). The suite was
re-run on the shipped default path after the flip.

### Sizing the callee-side narrowing lever

Lever (a) — narrowing the callee's regfile protocol — was sized before
building it, with two new idealcall arms: `calleeonly` (the bulk
8-load/8-store callee under a minimal caller + budget) and `narrowed`
(the full 9-spill faithful caller over a callee that loads only the
register it reads and stores only the one it writes — the shape a
def/use-narrowed callee would emit). Two interleaved runs of 9 reps,
10M calls each:

| arm | run A | run B | spread |
|---|---:|---:|---:|
| plain | 22.3ms | 22.2ms | ±20–22% |
| budget | 40.3ms | 40.2ms | ±9% |
| regmem | 33.3ms | 34.0ms | ±12–58% |
| faithful | 107.0ms | 81.8ms | ±4–7% |
| calleeonly | 80.0ms | 80.8ms | ±5–12% |
| narrowed | 66.1ms | 65.6ms | ±3–4% |

(native ≈13.5ms at ±87% spread — this box regime is not the one the
original five-arm table ran in; cross-run absolutes are incomparable,
within-run interleaved deltas are the signal.)

Three findings:

1. **The bulk callee protocol is the largest stable cost**: over the
   budget+minimal-caller base (40.2ms), it adds +40.6ms — and a
   def/use-narrowed callee under an even *heavier* caller adds only
   +25.4ms. Every callee-narrowing comparison wins by ≥15ms/10M calls
   (≥1.5ns/call) in both runs. The lever is real; the emitter already
   narrows to `touched(r)`, so the buildable refinement is dataflow:
   entry-load only read-before-def registers, spill only dirty ones at
   interior calls, reload only live ones after — and the same for xmm,
   where `xSpillAll` spills every used register at every call site.
2. **The faithful arm is bimodal across runs** (107.0 vs 81.8 at ±4–7%
   within-run spread) — the 9-store caller spill costs 27ms in one
   regime and ~nothing in the other. Conclusions that depend on it are
   recorded per-run, not averaged.
3. **Correction: the budget wrap is not free.** The five-arm table
   measured budget within noise of plain; in this regime it reproduces
   at +18ms/10M calls (~0.9ns per wrap) twice, outside both arms'
   spreads. The earlier "free within noise" was a property of that
   run's regime, not of the check.

### Spill narrowing: the store half, built and measured

The store half of the lever is implemented: every spill site (calls,
syscalls, deopts, exits) is emitted as a marker and expanded after the
whole CFG exists, skipping registers whose local provably equals their
regfile slot. Cleanliness is tracked mechanically over the emitted text
(any `local.set` of a synced local dirties it; the exact protocol reload
pattern cleans it), with a per-block bit-vector fixpoint over `succs`
(jump-table edges included via jtabUnion; the entry block joins an
all-clean function-entry state with its back edges). Opt-in via
`OXWASM_NARROW=1` / `globalThis.__narrow`; a surviving marker throws
rather than poisoning the unit.

Static effect is large — on sha256sum it skips 61,959 of 119,448 spill
stores (52%) across 7,088 sites. Gate: full suite green in both lever
states, breadth 31/31 byte-identical with it on. Steady state, measured
with realab's two-N subtraction:

- gzip: **1.008x, inside ±9%** — expected, since default-on inlining
  already removed gzip's hot call sites.
- perl (arithmetic loop; opcode dispatch is indirect calls inlining can
  never remove): **0.970x, inside ±4%** at the best measurement quality
  (startup 46% of the big run). A mid-quality run (startup 71%) showed
  0.803x and did not replicate — recorded as the artifact it was.

Verdict: the store half is roughly free but not a measured win. That is
consistent with the idealmem finding that stores are the cheap,
well-buffered half; the loads — the 8-register entry reload and the
full post-call reload — are untouched and sit on the critical path.

Two facts sharpen the next increment:

- **perl steady state is 7.0x native** (0.554µs vs 0.079µs per
  iteration), with only 107k interpreted instructions in a whole run —
  99.99% of it executes in wasm units. perl is pure call-tax, not an
  interpreter-coverage problem. (An earlier cold-cache reading of
  "185x" was first-run wat2wasm of 1,147 functions — precisely the
  artifact realab exists to subtract.)
- **Reload narrowing does not need a third state** — the design fear
  above dissolved on closer inspection: expanding spills *before* the
  backward liveness pass makes each expanded spill's `local.get` a use,
  which forces the reload on any path that could later spill the
  register; an elided reload therefore proves the local dead until a
  full redefinition, and the forward pass's post-call "clean" stays
  exactly right (slot authoritative, spills suppressed).

### Reload narrowing: built, one real miscompile, and a decisive null

The load half is implemented (reload markers + backward liveness, defs
firing at the local.set's *closing* paren after its expression's uses —
the first cut ordered events by text position and a read-modify-write
first instruction killed its own entry liveness, eliding ld.so's
incoming rdi reload; bisected with the per-function
`OXWASM_NARROW_ONLY` lever, pinned by `narrowtest.mjs`, which fails
2/4 with the bug reinstated). On sha256sum the two passes skip 52% of
spill stores and 55% of reload loads. Full gate green both lever
states; breadth 31/31.

The measurement, though, is a decisive null: perl steady state with
BOTH halves is **0.993x, inside ±8%** — cutting more than half of all
protocol memory traffic moved nothing. Conclusions:

1. **The call-tax remainder is not regfile memory traffic.** The
   regfile is L1-hot and V8 hides those accesses. This also exonerates
   the long-standing xmm-spillAll suspect for the 6.4–8x engine gap —
   xmm spills/reloads were narrowed along with the rest.
2. The surviving suspects for call-dense code are the **dispatch
   machinery**: the `$ftr` hash lookup per indirect call, the
   megamorphic `call_indirect` (which V8 cannot inline or predict),
   and the second `$ftr` lookup on the return path (`tailJmp`). The
   next idealcall arm should price exactly that: direct call vs
   hash-lookup + call_indirect through a funcref table.

### The dispatch price, measured — and it is the whole gap

`idealdisp.mjs` isolates how a callee is reached, identical minimal
protocol in every arm (median of 9, 10M calls, interleaved):

| arm | ms | vs native |
|---|---:|---:|
| direct call | 33.7 | 2.46x |
| call_indirect, constant index | 42.2 | 3.08x |
| call_indirect, alternating targets | 41.3 | 3.01x |
| the engine's callind shape (verbatim `$ftr` probe + ftHit guard + fuel/depth) | **104.7** | **7.64x** |

7.64x is perl's measured 7.0x. The full out-of-unit dispatch nearly
triples the call: +6.3ns/call over a bare call_indirect. This squares
with the narrowing null: spill/reload stores are independent and
store-buffered, but the ftr sequence is a *data-dependent latency
chain on the call target itself* (hash multiply → probe load →
compare → index load → call_indirect) that nothing can hide.
Polymorphism, notably, is free — V8's call_indirect doesn't care that
the target alternates.

The lever this points at is **per-site inline caches**: guest indirect
call sites are overwhelmingly monomorphic (perl's op-function pointers
are stable per site), so a per-site {key, fti} word pair turns the
common case into two loads and a compare; and the `!canDirect` direct
targets have *constant* keys, whose fti is stable once the callee is
registered — those can cache the resolved index outright. Open
questions before building: whether registerAotFn can re-register an
address with a different table slot (would need a generation word to
gate ICs), and where the IC slots live (the 128KB between FTHASH's end
at 0xE0000 and RAMOFF).

### From inline caches to an inlined probe — and default-on

The IC was built, and reality corrected the design twice:

1. **The perl A/B caught the megamorphic failure mode**: perl's runloop
   dispatches every pp_* op through ONE callind site, so the 1-entry
   cache missed, refilled, and thrashed — 1.100x, 10% *worse* than no
   cache. First-collision demotion (key ← −1, permanently) brought it
   back to noise. The general lesson: interpreter-style guests funnel
   calls through few megamorphic sites, where per-site caching cannot
   win by construction.
2. **The six-arm idealdisp then showed the IC was the wrong shape
   entirely**: ftr 7.58x, IC hit path 5.60x, the same first probe
   *inlined at the site* 4.85x, bare call_indirect 3.17x. The largest
   single cost was the `$ftr` wasm call boundary itself (~3.7ns/call),
   not the probe.

So the IC machinery was removed and every resolution site — callind,
out-of-unit direct calls, tailJmp — now inlines the hash and first
probe, with the full `$ftr` walk as the first-probe-miss fallback
(chain collision or unregistered target; the hash is 40% loaded).
Bit-identical by construction: same hash, same table, same sentinel.
Stateless, invalidation-free, and it works for megamorphic sites.

Measured on perl (two-N, reps of 5): **0.934x and 0.871x across two
independent runs** (second outside its ±8% spread) — a 7–13%
steady-state win on call-dense code; fastdisp+narrow combined measured
0.864x, i.e. narrowing still adds nothing on top. Full gate green
(suite both lever states, breadth 31/31), so `fastDisp` is now
**default-on**; opt out with `OXWASM_FASTDISP=0` /
`globalThis.__fastDisp = false`. Packed pages pick it up on their next
repack, since the pack pipeline shares `compileUnitWat`.

### The dispatch residue, fully decomposed — and where it ends

Nine idealdisp arms close the investigation (box spreads large; arm
ordering across repeated runs is the signal):

| arm | ms | note |
|---|---:|---|
| direct call | 36–39 | |
| call_indirect | 43 | +0.7ns/call over direct |
| + guard, constant index | 61 | the ftHit + fuel/depth dance: **+1.8ns/call** |
| + guard minus fuel check | 67≈61 | fuel and the duplicate depth load are free |
| + inlined probe | 68–72 | the probe itself: ~1ns |
| probe as one v128 load | 71≈70 | fusing the two loads buys nothing |
| per-site IC | 75–80 | worse than the inlined probe |
| out-of-line `$ftr` | 102–104 | the wasm call boundary: ~3.7ns |

Conclusions: the shipped inlined probe sits ~2.8ns/call above bare
call_indirect, of which ~1.8ns is the guard — and the guard's cost is
*structural* (the conditional wrap and the stores bracketing the call),
not any single load or check, so no cheap tweak removes it. Below that
lies V8's own indirect floor. The remaining lever for call-dense code
is **pack-time direct linking** — resolving cross-unit calls to direct
wasm calls (and statically bounding depth to drop the guard) when all
units exist at pack time — a build-pipeline project, not an emitter
tweak, parked with this note as its justification.

### Checkpoint after the three shipped levers

With inlining, fast dispatch, and the repacked container all default-on,
a same-day standing check:

- **Default-tier kernel table unchanged** (alu 3.43x, mem 4.34x, call
  11.6x, branch 1.75x, muldiv 1.62x) — matching the standing
  default-tier column; the straight-line gap remains Liftoff occupancy,
  not codegen.
- **Top-tier `call`, same-day lever A/B: levers OFF 9.14x ±5%, levers
  ON 7.8–8.0x — a ~14% improvement** from inlining+fastdisp on the
  call-densest kernel. The previously published 6.37x is NOT comparable
  to either number: the box's native calibration runs swung 2x between
  arms measured minutes apart (1504ms vs 3363ms for the same kernel),
  so cross-day absolute ratios on this machine carry that swing.
  Same-day interleaved or paired arms remain the only trusted
  comparison, as every corrected claim in this document keeps
  re-learning.
- **perl, defaults vs ALL levers off: 0.985x inside ±5%** (startup 5%
  of the big run — the cleanest perl measurement yet). Read together
  with fastdisp-alone at 0.87–0.93x, the levers pull opposite ways on
  perl: fast dispatch wins ~10% and inlining gives most of it back
  (perl's call sites are indirect, so inlining can only duplicate code
  it cannot devirtualize). On gzip the roles reverse. The defaults are
  a net win on call-direct workloads and a wash on indirect-dispatch
  interpreters — a future refinement could gate inlining on the
  direct-call share of the profile.

  **Correction (next day, and it kills the gate idea): the "inlining
  gives it back" attribution does not reproduce.** A direct paired A/B
  of exactly that claim — perl runloop (pure compute driven to an
  11.7s steady state, startup subtracted), inline-on vs inline-off,
  fastdisp on in both arms — reads **1.004x ±8%**: inlining is a null
  on perl, not a cost. The wash in the defaults-vs-all-off run was
  real, but pinning its shape on inlining was an inference from
  arithmetic across separate runs (0.985 ≈ 0.87 × cost), the exact
  cross-run comparison this document keeps warning against. There is
  no perl regression to gate away; the profile-gated-inlining
  refinement is dropped as unfounded.
3. Narrowing stays **opt-in**: perf-neutral steady state at current
   resolution, and its on-thread analysis costs ~+25% startup in
   realab (perl small runs: 14.7s vs 11.6s). If it is ever promoted,
   the analysis belongs off the critical path first.

### Where the goal stands (session checkpoint, 2026-09-01)

The target is "any unmodified Linux binary, same-or-faster than native."
Today's honest ledger:

**Correctness** — 52/52 unmodified binaries byte-identical to native
(coreutils through xz/gzip/zstd/bzip2, three interpreters — perl, python
with its stdlib, mawk — jq, openssl, git log/status/init against a real
repo, file(1) with its magic database, sh and dash). The verification
suite carries hardware differentials for every silicon-semantics bug
found this session (movhlps, bsf/bsr, leave's implicit rbp, narrowing's
RMW ordering), each of which fails on the pre-fix emitter.

**Straight-line compute** — parity under V8's top tier (alu 0.87x–muldiv
1.02x); the default-tier gap (1.6–4.3x) is Liftoff occupancy, revisited
and confirmed unchanged today. On a page, Chrome tiers after one call
and the implicit code cache starts repeat visits at the top tier.

**Call-dense compute** — the residue. The protocol memory traffic is
exonerated (narrowing null), dispatch is fixed to the inlined first
probe (7–13% on perl; default-on), and the decomposition bottoms out at
V8's own floors: bare call 2.1–2.5x, call_indirect ~3x, plus ~1.8ns of
structural guard. perl sits near 6x. The one unplayed lever is
pack-time direct linking (a build-pipeline project, justified in the
section above); nothing smaller moves this number.

**The shipped product** — the GIMP page draws at 29–36ms warm-stroke
medians on the repacked container (fast dispatch in all 4,058
recompilable units, exact export parity), with the measurement stack
now window-relative and retry-hardened: zero dead runs across the final
verification set. One honest open question: the probe's own latency
buckets attribute the ~32ms to neither wait nor work (both ~0), so
what those two frames actually contain — rAF pipelining, compositor
latency, or instrumentation gap — is unmeasured, and it is the next
question the stroke number depends on.

### The stroke's 32ms, accounted for

`cdp_latprof.mjs` (page lever `?latprof`) splits the previously
unattributed input→paint span — cdp_draw's wait/work buckets turned out
to be vestigial fields the page no longer fills. Median decomposition
over a 24-step stroke:

```
input -> inject   4.3ms   the event waiting for a pump slice to pick it up
inject -> blit   17.5ms   guest brush work (~9ms, ≈3x native - the standing
                          engine band) + rAF alignment (~8ms)
total            27.2ms   (tail samples to ~113ms: tier-up/GC bursts)
```

Native GIMP spends ~3ms of brush work inside a ~16ms vsync frame; the
page pays the same work at engine speed plus one rAF alignment. The two
levers this exposes, in order of cheapness: blit on damage instead of
waiting for the next rAF (~8ms, at the cost of decoupling from the
compositor), and the call-dense 3x itself (the pack-time linking
project). The 4.3ms pickup could also shrink by injecting motion on
event arrival rather than at the next slice boundary.

### Slice-end paint is the default

The cheap lever landed: the pump now blits at the end of the slice that
dirtied the framebuffer instead of scheduling the next rAF, and drains
the input queue at the same point (which also removes the 4.3ms pickup —
the next motion event is consumed the moment the previous paint is on
screen). `?rafblit` restores the compositor-aligned path.

Paired latprof A/B, twice, second time on a quiet box (load 0.14):

```
                 first pair     quiet-box rerun
slice-end paint    19.8ms          18.3ms   (1.4ms pickup + 16.6 work)
?rafblit           35.5ms          34.2ms   (4.7ms pickup + 28.6 work)
```

A verification round between the two degraded across BOTH arms (box load
3.1 from an unrelated tenant, partial ink even under `?rafblit`) and is
recorded as box noise, not evidence — the same lesson as the wall-clock
kernel runs: on this box only same-run paired arms mean anything. At
~18ms input→paint the stroke sits at about 1.2x a native 16ms frame;
what remains is the ~9ms guest brush work (≈3x native, the standing
call-dense band) that pack-time linking would address.

### Breadth 60: epoll, and what a guest's stderr is worth

Eight new cases: four coreutils lanes the sweep lacked (`sum`, `pr`,
`ptx`, `shuf` — the last with `--random-source=` pinned to the input
file, making the permutation a pure function of provisioned bytes), two
busybox applets, and two more real interpreters, ruby 3.3 and php 8.4.
busybox is the sweep's first statically linked binary — entry straight
at `_start`, no PT_INTERP, no ld.so — and it passed untouched, which
retroactively certifies a whole lane the dynamic cases never exercise.

ruby and php both failed on the first run, and the fix that mattered was
to the harness before the engine: breadth now prints the guest's own
stderr, the syscalls that hit the ENOSYS default, and (under
`BREADTH_STRACE=1`) a ring of the last 400 syscalls with decoded paths.
That turned two identical "exit 127 vs native 0" lines into three
distinct root causes in one run each:

- **ruby**: `[BUG] epoll_create (errno:38)` — the engine had no epoll at
  all. It now implements create/create1/ctl/wait/pwait as a
  level-triggered scan over the same readiness sources poll uses
  (EPOLLET accepted and ignored — with the whole machine in one JS
  thread, a level scan at each wait is observationally close enough).
- **ruby, second failure**: a silent exit 1 that the strace ring decoded
  as `clone3=ENOSYS` (glibc falls back to clone — harmless) followed by
  a run of `mmap=-ENOMEM` at ~500MB: ruby reserves that much address
  space at boot and gives up quietly when refused. Case config, not
  engine: `memMB: 1024`.
- **php**: `*** buffer overflow detected ***` — a glibc fortify abort
  immediately after `openat("/usr/share/zoneinfo/")=-ENOENT`. php scans
  the system tzdata at startup; with the directory unprovisioned it
  takes a fallback that aborts. Provisioning the tree (2MB, the same
  files native scans) makes it byte-identical. The fallback-path abort
  was then closed by the decisive experiment: native php 8.4 in a
  minimal chroot without zoneinfo aborts with the identical fortify
  message (exit 134) — the engine was faithfully reproducing a real php
  bug, instruction for instruction, in a code path that php's own
  developers presumably never run. The one infidelity was the exit
  code: the guest reached 127 through tgkill=ENOSYS plus glibc's
  fallback exit where the kernel says 134, so kill/tkill/tgkill now
  take the default action for self-delivered fatal signals (terminate
  with 128+sig; sig 0 stays a liveness probe), breadth normalizes
  node's signal-death status to the same convention, and an `abort`
  case (dash `kill -ABRT $$`) pins the lane — it fails on the pre-fix
  engine with exit 0 and a shell error, and runs the `echo unreachable`
  that native never reaches.

The pattern across all three: the failure printout that names the
guest's complaint (a [BUG] line, an errno, a path) converts a debugging
session into a diff read. Suite green, breadth 60/60.

### Direct linking priced — and the dispatch story ends

Five new idealdisp arms measure what direct linking (pack-time or
incremental runtime) would actually buy for the closure-pruned
constant-target call sites that today pay the inlined probe. The callee
lives in a separate module instance sharing the memory; the caller
imports it and calls it directly — exactly the shape a unit could emit
once the owning unit exists:

| arm | ms | note |
|---|---:|---|
| impcall | 37.8–39.2 | bare cross-instance import call ≈ direct (33) |
| impsplit | 38.2–38.7 | alternating between two instances: the switch is free |
| impdepth | 59.3–59.5 | + the depth bracket a linked call must keep |
| impgdep | 58.3 | same bracket on a mutable Global: **identical** |
| gguard | 76.8 | full guard on globals + imported table: worse |

The bracket is structural, now proven from a second angle: linear
memory vs `WebAssembly.Global` for depth/fuel measure the same, so the
cost is the conditional wrap and the stores, not where the counters
live. And the bracket is load-bearing — it is what turns unbounded
guest recursion into a deopt at a spilled, coherent call site instead
of a wasm stack trap mid-frame, where the guest state is unrecoverable.
The shipped intra-unit direct call already pays it (the emitter guards
direct calls too), so a linked cross-unit call lands at impdepth ≈ the
intra-unit direct call ≈ the guard arm (58.8). All linking can remove
is the probe: inlprobe 66.8 → 59.5, **~11% on the pure-call kernel**,
single digits once real code dilutes the call fraction.

Decision: pack-time direct linking moves from "parked" to **closed,
priced** — an import-graph build pipeline (instantiation order, cycle
handling, funcref plumbing) buys less than one box-noise band. The
dispatch avenue is exhausted end to end: probe shipped (fastdisp),
IC tried and beaten by it, v128 fusion null, guard structural twice
over, linking ≤11% ceiling. What remains of the call-dense band lives
in the frames themselves (inlining, which ships) and in tier
occupancy, not in how calls are reached.

### Node.js runs — and what it took

The sweep's biggest binary yet: Node 22 (`--jitless -e 'console.log(6*7)'`),
124MB of V8, libuv, epoll and worker threads, byte-identical to native at
exit 0. Four gaps stood between "spawns" and "prints 42", each surfaced by
the failure printouts in order:

1. **Infinite RLIMIT_NOFILE**: the engine reported rlimits as infinity;
   node's close-on-exec sweep then walked 16M descriptors of interpreted
   fcntl before reaching main. Rlimits now come from one table — STACK
   finite (pthread sizing), NOFILE 4096/1M plausible.
2. **fcntl on a dead fd answered 0**: F_SETFD tracked every one of those
   16M fds in the cloexec set until the JS Set hit its 2^24 ceiling and
   took the engine down ("Set maximum size exceeded" — the engine
   crashing, not the guest). Any fcntl on a missing fd > 2 is now EBADF.
3. **epoll** (from the ruby work) — node's event loop lives on it.
4. **pop r/m64** (grp1a 8f /0): first binary in the sweep whose code uses
   it — V8's codebase, fittingly. Decoder + emitters, with the rsp-based
   memory destination refused to the interpreter (its address is computed
   AFTER the increment, and the interpreter's set-after-pop order is the
   exact semantics); a popm differential slice joins implicittest.

Also new this pass: the subprocess lane in breadth (a real shell driving
gzip|md5sum and seq|sort|head pipelines through fork/execve/pipes/wait4),
dd, cmp, and date. 67/67. The full-JIT node — V8 writing machine code
into pages at runtime, the self-modifying-code frontier for
address-keyed AOT units — is the next experiment.

### JIT-in-JIT: V8 generates machine code and the engine runs it

Full-JIT node is the self-modifying-code frontier: V8 writes Sparkplug,
irregexp and TurboFan machine code into rwx pages at runtime, and the
engine both interprets AND TIERS that generated code — address-keyed
translation of instructions that did not exist at ELF load. Status:

- `node -e 'console.log(6*7)'` (full JIT): byte-identical, exit 0.
- The stress — a 3e6-iteration loop TurboFan optimizes plus 100k
  matches of an irregexp-compiled regexp — prints the exact native
  output. 9,973 units, ~4,300 of them translations of V8-generated
  code. One new opcode fell out: `mov rax, [moffs64]` (A0–A3), which
  V8 emits for external references and nothing in 68 static binaries
  ever used.
- A sized-down variant (3e5 iterations, Sparkplug + irregexp) is now
  breadth case `node-jit`. 68/68.

The correctness hole this exposed: `munmap` was a no-op and unit
registration write-once, so a recycled code page (V8 GCs code
constantly) would keep dispatching into stale translations of bytes
that no longer exist. munmap now drops every compiled artifact whose
entry lies in the range and rebuilds the dispatch hash without them —
skipped entirely for data-buffer munmaps that intersect nothing.
The recycle regression now exists: `tools/fixtures/recycle.asm` is a
120-line hand-rolled static ELF that tiers a hot function at a fixed
rwx page (12 calls through the call profile), munmaps it, maps a
different function at the same address, and prints which one actually
ran. With the invalidation neutered the engine prints "A\n" — the
stale translation, exactly the bug — and with it, "B\n" byte-identical
to hardware. It runs in the sweep as case `recycle` (built from the
committed asm when nasm is present). 69/69.

Still open, documented rather than half-fixed: in-place patching of
still-mapped code (V8's deopt and IC rewrites), which no munmap ever
announces. A faithful catch needs write tracking on pages that hold
translations (QEMU's approach: write-protect and trap) or a per-entry
prologue byte-check, both of which tax the hot dispatch path; the
full-JIT stress passing suggests V8's write-once discipline makes this
rare in practice, but it is a real hole and stays on the ledger.

### gcc/cc1: a masked codegen bug, and an execve-child lead

Pointing the sweep at the C toolchain (gcc's driver spawning cc1) split
into two findings, one fixed and one parked.

**Fixed — rol/ror qword [mem] miscompiled in unit mode.** cc1 run
directly (skipping the driver) compiles hello-world to byte-correct
assembly, but its tier-up emitted units full of `$rundefined`, which
wat2wasm rejects — so every unit containing the offending instruction
silently fell back to the interpreter and never tiered. Root cause: the
unit emitter's 64-bit rol/ror branch hardcoded `local.set
$r<dst.r>`, assuming a register destination. cc1's switch dispatch does
`rol qword [table + idx*4], n` — a memory destination, so `dst.r` was
undefined and the local name came out `$rundefined`. The 32-bit branch
right beside it already split register vs memory through `wr()`; the
64-bit branch never did. One-line fix (route through `wr`, which emits
`i64.store` for a memory operand), pinned by a unit-mode `rol/ror
[mem64]` case in rottest that emits `$rundefined` and fails on the
pre-fix emitter. Correctness was never at risk — wat2wasm's rejection is
a hard stop, not silent corruption — but the tiering hole was real:
these units ran interpreted.

**Parked — the fork+AOT corruption (was mis-filed as an "execve-child
mapping" bug; that guess was wrong).** Through the gcc *driver*, the
run faults with `unsupported opcode 2f at 155f4c0`. A dump at the fault
corrected the story: it is the **gcc driver** (a ~1MB binary) whose own
`rip` is 0x155f4c0 — far past its highest mapped segment (~0x4fd000) —
so the driver made a wild jump to what happens to be an address in
cc1's range; cc1 itself (a separate child engine) is loaded correctly.
The driver's strace ends `vfork()=1000` (pid to parent), the child does
`close(3)` then `execve(cc1)`, and the parent then resumes with a
corrupted `rip` (= the execve path-string pointer) and stale registers,
executes a bogus "syscall 1000" (the vfork pid still in rax), and
faults. So the parent's control flow was derailed after its vfork child
exec'd.

The bisection is decisive about the *conditions*, not yet the
mechanism:

- **No-AOT (`assembleWat: null`) → byte-identical, exit 0.** With
  tiering off the whole gcc→cc1 compile produces the exact native
  assembly. So this is an AOT-dependent corruption.
- **gcc `-###` (driver + AOT, never forks) → clean.** The driver's own
  translated code is correct.
- **cc1 run directly (top-level, AOT) → clean** (it produces correct
  `.s`, 878k interp insns + tiered units).
- Only **fork + AOT together** corrupts. Ruled out along the way: the
  vfork is executed interpreted, not from inside a wasm frame (a
  deopt-on-fork-from-wasm fix changed nothing and was reverted); and no
  AOT unit is dispatched while the vfork rollback journal is armed (so
  the child is not bypassing the journal through compiled code).

What is left is the interaction between the vfork window's
save/restore of tiering state (`aotBudget`, the write journal, the
shared regfile at wasm offsets 0–511) and the parent's resumption into
or after a tiered unit. That is the next thing to instrument: trace the
parent thread's control flow across the vfork window with AOT on, and
find the store (or the stale spilled register) that plants the
path-string pointer where the parent's next `ret`/indirect-call reads
it. The whole compiler/toolchain breadth lane waits on it; GIMP's
plug-in launcher (also fork+exec) does not hit it because its pre-exec
child makes far fewer memory-touching syscalls than gcc's.

A second instrumentation pass narrowed the *mechanism* further, mostly
by elimination: the transfer to 0x155f4c0 is **not** an interpreted
control transfer. A ring buffer over every interpreter step, and a
guard on the interpreter's `ret`/`jmpind`/`callind` for any target
past the driver's image (≥ 0x1000000), both stayed silent through the
fault. So the driver reaches 0x155f4c0 either inside a live AOT wasm
frame (a compiled `ret`/`jmpind` that reads a corrupted code-pointer
slot and returns there, deopting into the interpreter at that rip) or
during a `tierUpAot`→`analyze` that follows a corrupted jump-table
edge. Either way a code-pointer-sized slot in the driver's guest
memory has been overwritten with the execve path-string address, and
the write is invisible to interpreter-level tracing — it is either a
compiled store or an engine-side syscall write. The next pass has to
watch the wasm side: instrument the deopt/`x_syscall`/`x_callout`
boundary, or scan for the moment a guest word acquires the value
0x155f4c0 outside the legitimate execve argv setup.

**Third pass — localized to a 10-second minimal repro
(`tools/fixtures/vforkexec.c`).** Two bisections collapsed the search:
giving the execve *child* (cc1) no AOT while keeping the driver's still
faults — so cc1 is irrelevant and it is the forking process's OWN
tiering. And the whole thing reproduces without gcc at all: a static
binary that tiers one hot function, `vfork`s, has the child `execl` a
static `/bin/busybox true`, then runs the hot function again in the
parent. Native and AOT-off print "survived"; AOT-on faults with
`unsupported opcode e0 at <stack address>`.

Instrumented, the fault is exact: an interpreter `ret` at guest
`__execve+0x24` — the error-return tail of `__execve` — pops a garbage
return address (a stack pointer) off a corrupted slot. So the **vfork
child does not stop after its execve**: the engine creates the child
engine, marks the thread dead and blocks it, yet under AOT the child's
interpreter runs on down `__execve`'s failure path (`neg eax; or
$-1,%rax; ret`) and returns through a stack slot whose value was
planted by a compiled (wasm) store — invisible to a `mem.write` watch,
which sees only the earlier legitimate writes. no-AOT stops the child
cleanly. The open question is now sharply framed: **how does a tiered
parent cause the dead, blocked vfork child thread to resume executing
past its execve?** — the resurrection path (a `wake()` that switches to
a not-actually-dead thread, or a `BlockUnwind` that unwinds into the
wrong frame under a live wasm callout) is the next thing to trace, with
a repro that runs in seconds.

**Fourth pass — it is a corrupted function-pointer TABLE, and the fault
thread is the parent, not the child.** A `_run1`-level (ti, rip) ring
across the fault shows ti=0 (the parent) running the ELF init/fini
function-pointer iterator (`call *0x10(%r15); add $0x18,%r15`), whose
current entry sends it — through a couple of hops — into `__execve` and
then off a corrupted return. So the earlier "child runs past its
execve" reading was the surface: the real damage is a **code-pointer in
the parent's `.data`/exit-handler array overwritten** with a value that
resolves into `__execve`, planted by a compiled store during the vfork
window; the parent iterates the table on the way to (or through) exit
and calls into it. `park()`/`wake()` behave correctly (no dead thread
steps, no bad wake-switch), which rules out the scheduler and points
squarely at an unrolled-back or mis-journaled write to that table
during the child's window. The write is a wasm store (invisible to
`mem.write`), so the decisive next instrument is a value-watch: trap the
moment a word in the fini/init array region acquires a code-pointer that
is not its original, with AOT on. Four passes in, this is a genuine
multi-layer bug; it is parked with a seconds-long repro and an exact
corrupted-structure identification so a focused session can close it
without re-deriving any of the above.

**Fifth pass — it is a REGISTER, not the table.** A snapshot/diff of the
whole exit-handler data region (`.data`+`.bss`, `__exit_funcs` and the
static `initial` block) across the vfork window shows **zero changes** —
the table is intact. What is wrong is `%r15`: at the fault it holds `1`
(so does `%rbx`), so the `call *0x10(%r15)` reads a non-pointer and
jumps to garbage. So the corruption is the parent's **callee-saved
registers not surviving the vfork+AOT boundary**, not any store to
memory. This flips the mechanism back toward regfile/spill handling:
the parent runs a tiered `hot()` after the vfork window, and either the
window's `aotBudget`/regfile save-restore or the second AOT dispatch's
`syncOut`/`syncIn` leaves `%rbx`/`%r15` clobbered where the guest code
expects them preserved. The decisive remaining datum is a straight
compare of the parent's callee-saved registers at three points —
entering vfork, resuming after the child execs, and at the fault — to
pin which transition zeroes them; a focused session should take that
comparison first.

After five localization passes across several autonomous check-ins
without a landed fix, this is explicitly handed off to a dedicated
debugging session rather than continued in hourly bursts: the repro is
seconds long, the corruption is now known to be register (r15/rbx), the
table is proven intact, and the scheduler is ruled out. Continuing to
probe it one hour at a time has low expected value; the breadth and
perf lanes ship reliably and should take the bursts.

**Sixth pass — corrected again, and the mechanism is finally coherent.**
A full register diff of the parent across the window overturns the
fifth pass: `%rbx` and `%r15` are *not* corrupted — they already held
`1` at the vfork syscall. Between vfork and the fault ONLY `%rax`,
`%rcx`, `%rsp` change, by exactly the amounts `__execve`'s error tail
writes (`or $-1,%rax`; `mov $-0x40,%rcx`; one net pop). So the parent
runs almost no instructions after the vfork — it lands in `__execve`'s
error-return tail and rets through a garbage stack slot. Decisive clue:
a probe on the first `ti==0` step after any `ti!=0` step in `_run1`
**never fires** — the vfork child never runs in the top-level loop. It
ran nested, inside an `interpUntil` under a live wasm callout. That is
the AOT coupling five passes kept circling: the parent hit `vfork`
inside a tiered unit's `x_callout` (not `x_syscall`, which is why the
earlier fork-from-`x_syscall` deopt fix never triggered); the child ran
nested on the shared stack; and its `execve` unwound that nested
interpreter, leaving the parent's live wasm frame resuming into
`__execve`'s tail. Fix: force an interpreter boundary for fork/vfork
reached from ANY nested wasm context (callout or syscall) so the child
is never spawned under a live parent frame — a single well-scoped
change now, not a search.

**Resolved.** The change was exactly that. `interpUntil` now carries a
nesting depth (`this._iuDepth`), and the thread-switching fork branch
(clone-without-CLONE_VM / fork / vfork), when `_iuDepth > 0`, rewinds to
the syscall and throws `DeoptUnwind` to re-execute at the top-level
`_run1` loop — the same interpreter-boundary discipline that blocking
syscalls already use to unwind cleanly out of a callout. With no wasm
frame beneath it the fork spawns the child correctly. `gcc -S` compiles
hello-world byte-identical to native under AOT; the minimal repro prints
"survived"; breadth carries `vforkexec` (which faults with the guard
neutered) at 79/79, engine suite green, and every existing fork+exec /
pipe / git / interpreter subprocess case still passes. Six passes to a
five-line fix, but each pass genuinely eliminated a wrong hypothesis
(scheduler, memory table, registers) before the nesting clue landed.

### The compiler lane: a whole C toolchain, byte-perfect and runnable

With the fork guard in, the full gcc pipeline runs end to end — the
driver vforks `cc1`, `as`, and `collect2` (which vforks `ld`), all four
executing as translated guest code. `gcc -c` and `gcc -S` produce output
byte-identical to native. The full link — `gcc -O1 hello.c -o a.out` —
completes with exit 0 and produces a **15968-byte PIE byte-for-byte
identical to native gcc's**, build-id included, and that binary **runs
under the engine** and prints its output. `gcc-S` / `gcc-c` / `gcc-link`
in breadth cover the three stages; the engine is now a C compiler that
builds runnable native executables entirely inside wasm. The **C++**
frontend works untouched too: `g++ -O1 hello.cpp` drives `cc1plus` (a far
larger front end than `cc1`), `as`, `collect2` and `ld` to a PIE
byte-identical to native g++'s, which runs and prints (`gpp-link` in
breadth, ~5 min under the engine for the heavier translation load). No
new engine work was needed — the read-past-EOF clamp was the whole gap.

### Signals: real delivery, at the kernel's checkpoints

Until now `rt_sigaction` was a stored no-op: handlers were recorded
nowhere, and the only "delivery" was the default action (a self-directed
fatal signal terminated with 128+sig). Anything that relies on SIGALRM,
SIGCHLD, SIGINT, `pause`, `sigsuspend` or timers simply hung or died. The
subsystem is now modelled the way the kernel does it, and it is exercised
by `tools/fixtures/signal.c` (`signal` in breadth), whose seven scenarios
byte-compare to native: an SA_SIGINFO handler entered by `raise()` with
`si_signo`/`si_code` checked and a live computation intact across it, a
signal blocked with `sigprocmask` held pending until unblocked
(`sigpending` sees it), `setitimer` + `pause` returning EINTR after
SIGALRM, an interrupted `nanosleep` (no SA_RESTART → EINTR), SIGCHLD from a
`fork`ed child's `_exit` reaped with `waitpid` inside the handler,
`sigsuspend`, and SA_RESETHAND.

**State.** Actions are per process (`sigact`: sig → handler, flags,
restorer, mask; SIG_IGN kept in `sigign`); the blocked mask, pending set,
alternate stack and the "a signal woke me" bit are per thread.

**Checkpoints.** Delivery happens only where the kernel delivers — on the
way back to user code — at three places: `_sigExit`, at the end of every
syscall (a self-`raise` lands here); `_sigEntry`, at the start of a
syscall a thread is re-executing after a signal woke it out of a blocking
call (`raiseSignal` flips a parked thread to runnable and marks it
`eintr`), which is where EINTR versus SA_RESTART is decided — the syscall
does not run, rax is −EINTR with the saved rip past the instruction, or
the saved rip is the instruction itself so it re-executes after the
handler; `pause`/`sigsuspend` never restart, and a pending signal at their
entry returns EINTR at once; and `_sigPoll`, once per run-loop iteration
(a single boolean when nothing is pending), so a signal raised into a
computing thread lands at the next instruction boundary.

**The frame.** A real x86-64 `rt_sigframe` is pushed below the red zone
(or on the `sigaltstack` under SA_ONSTACK), 16-aligned minus 8 as at a
call: pretcode = the SA_RESTORER, then a full `ucontext` with
`uc_mcontext.gregs` in the kernel's order, eflags, cs/ss, the saved
`uc_sigmask` (the *pre-`sigsuspend`* mask when that is what is being
restored), and a 128-byte `siginfo` with `si_signo`, `si_code`
(SI_USER/SI_TKILL/SI_KERNEL/CLD_EXITED) and `si_pid`/`si_status`. The
handler gets rdi/rsi/rdx = sig, &info, &uc with DF clear; the mask is
widened by `sa_mask` plus the signal itself unless SA_NODEFER.
`rt_sigreturn` restores every general register, rip, the arithmetic flags
and the mask from that frame — nothing is kept on the host side, so a
handler that longjmps out is fine.

**Compiled code.** From a wasm unit the syscall import runs the same
`syscall()`; if delivery or `rt_sigreturn` moved rip, the import publishes
the registers and throws `DeoptUnwind` so the unit's frame unwinds and
`_run1` resumes at the new rip — the unit would otherwise have carried on
at its own next instruction. The first AOT run of the fixture found the
one real gap in the design: a fork child that exits *without* exec takes
the in-engine exit path, not the child pump, and raised no SIGCHLD; the
parent then re-entered `pause` forever. The exit path now raises SIGCHLD
to the parent thread explicitly.

**Timers and sources.** `alarm`/`setitimer`/`getitimer` keep one
ITIMER_REAL (one-shot or interval) checked by `reapTimers` (so a parked
thread wakes for it) and folded into the host-facing deadline; SIGCHLD
comes from both child paths; `kill` to a child pid reaches that child's
engine; `tkill`/`tgkill` target a thread. Default actions: terminate,
except CHLD/CONT/URG/WINCH (ignored) and the stop signals (not
modelled). Not yet modelled: SIGPIPE on a write to a reader-less pipe,
`rt_sigtimedwait`/`signalfd`, per-thread ITIMER_VIRTUAL/PROF, and
delivery into a vfork-window child.

**A harness lesson that looked like an engine bug.** With the AOT tier on,
`breadth` reported the fixture never exiting while the same binary passed
under a bare runner — not a compiled-code fault at all: the harness wakes
a blocked engine *immediately* and counts iterations, so its guard of
4000 burned out in ~40 ms of wall time, before the 20 ms timers were due.
The harness now sleeps until the engine's reported deadline (as the
browser pump does) and does not count a deadline wait as a no-progress
iteration.

**The one real regression, caught by the suite's shell test.** busybox
`sh -c` tail-execs its last command without a fork; the engine keeps the
old shell image parked so that its re-stepped `execve` blocks forever
while the replacement runs. When the replacement (`cat`) exited, the child
pump raised SIGCHLD *on the old engine*, delivery marked its retired thread
interrupted, and the re-stepped `execve` came back EINTR instead of
re-blocking — the dead shell printed "cat: Interrupted system call" and
exited 126 with byte-perfect stdout. A signal to a process whose image has
been replaced (`_execed`) is now dropped, and no checkpoint delivers to a
dead thread. Gate: engine/test.sh (316/316 hardware differentials, the
shell pipeline exact) and the full breadth sweep, both green.

### Shared mappings, mremap, SIGPIPE — and pipes that hold 64KB

Three more entries from the correctness ledger, each with a deterministic
fixture that byte-compares to native (`mshared`, `epipe`, `sigpipe-sh` in
breadth):

**MAP_SHARED write-back.** `mmap` copied a file in and nothing ever copied
it out, so stores through a shared writable mapping were silently lost.
The mapping record now keeps its handle and a `shared` bit, and the pages
are copied back into the file at `msync`, at `munmap` (only records fully
covered are dropped; partial unmaps still flush), and at process exit for
anything still mapped — the fixture leaves a dirty mapping at exit and the
harness compares the file after the process is gone. Only bytes inside the
file's current length are written: a store past EOF within the last page
does not grow the file, as on Linux. Coherence in the other direction
(`write` after `mmap` showing up in the mapping) is still not modelled.

**mremap.** Shrinks in place; grows only with MREMAP_MAYMOVE, by taking a
fresh region, copying the old pages, zeroing the tail, moving any file
mapping record along and invalidating translations in the old range;
ENOMEM otherwise.

**SIGPIPE / EPIPE.** A write to a pipe whose read end is open nowhere in
the process tree (a `_pipeReaderAlive` scan mirroring the writer-side one
that sets EOF) raises SIGPIPE, and returns EPIPE if the writer survives it
(SIG_IGN or a handler). The default action needed a real
`_terminate(sig)`: a fork child still in its vfork window is a *thread* of
the engine, so only it dies — journal rolled back, parent released, and its
status recorded so `wait4` reports WIFSIGNALED/WTERMSIG (previously every
child status was WIFEXITED); a whole-process death remembers `termSig` for
the same reason. `yes | head -1` under bash prints `141 0` from PIPESTATUS,
as native does.

**The bound.** With the AOT tier on, `yes | head -1` hung: the engine's
pipes had no capacity, and a compiled `yes` pushed gigabytes of chunks
before `head` was ever scheduled. Pipes now hold 64KB — a writer that
finds one full blocks until a reader drains it (EAGAIN when non-blocking;
`writev` returns a short count if part of the vector went through), and
every pipe read wakes blocked writers. This is the same "spurious wake,
re-execute the syscall" model the rest of the scheduler uses.

**A limitation the SIGPIPE fixture exposed.** The engine's `fork` is
vfork-shaped: the child runs first and the parent stays frozen until the
child execs or exits. A native race (parent closes its read end, child
writes) therefore resolves the other way here, and a child that *blocks
waiting on its parent* before exec deadlocks. The fixture was made
order-independent (the read end is closed before the fork); the model gap
itself — a real fork with copy-on-write pages and a runnable parent — is
recorded as the next structural item.

### Fork materialisation: the vfork window pays for its copy only when it must

The 64KB pipe bound made the structural gap urgent: busybox runs many
applets (`seq`, `yes`, `echo` …) in the forked child *without* an exec, so
`x=$(seq 1 30000)` — 170KB into a substitution pipe the frozen parent is
supposed to be reading — would now block the child with nobody to drain it.

The fix keeps the vfork window (fork+exec still costs no memory copy) and
adds one rule in `park()`: **a fork child that blocks inside its window is
materialised into a real child process.** `_materializeFork` builds a new
engine from the same image and options (the constructor's arguments are
kept for this), copies the RAM *as the child sees it* (its own writes
included), hands it the copied fd table, cwd and signal dispositions, seeds
its CPU from the thread (rip at the syscall it blocked in, so it simply
re-executes there; an interrupted `nanosleep` keeps its deadline), then
rolls the parent's journal back and releases the parent. From there the
child is driven by the child pump exactly like an execve'd child — SIGCHLD,
pipe EOF and `wait4` all already work that way. The child starts cold in
the tiers, since compiled units are bound to the parent's memory. A child
that has live in-engine children of its own stays in the window (they are
threads of this engine).

`tools/fixtures/forkblock.c` (`forkblock`) checks both blocking shapes and
copy-on-write in both directions: the child writes 200KB into a pipe and
the parent reads it all and reaps exit 3; then the child sets a global to 7
*before* blocking on a read the parent has yet to satisfy, and after the
exchange the parent still prints 1 while the child reports 7. `bb-subst`
is the busybox case that motivated it. Both byte-compare to native.

The remaining fork divergence is the ordering inside the window: the child
runs first, so a race the parent would normally win natively (closing its
end of a pipe before the child writes) resolves the other way. Semantics
are POSIX-legal either way; fixtures are written order-independent.

### The syscall surface, surveyed — and a synthetic /proc

Breadth now prints, for every case, each `ioctl` request answered ENOTTY
and each syscall answered ENOSYS, aggregated over the whole engine tree.
Across the 94-case sweep the ledger is short: the ENOTTY requests are
`TCGETS` on pipes and files (the right answer — that is `isatty()`
probing) and a single `FIOCLEX`; the ENOSYS list is `clone3` (glibc falls
back to `clone`), `io_uring_setup` (correctly unsupported, libuv probes
it), and three cheap misses now implemented — `clock_getres`, `capget`,
`mincore` — alongside `FIOCLEX`/`FIONCLEX`, `FIONBIO` and `FIONREAD`,
which are descriptor-generic and now answered before the tty gate.

The larger gap the survey did not show — because nothing in the sweep
read it — was `/proc`: only `readlink` of `/proc/self/exe` and
`/proc/self/fd/N` existed, so every `open` under `/proc` was ENOENT.
`lookup` now falls through to `_synth(path)`, which generates the files
real programs read, from live engine state: `/proc/self/{cmdline, environ,
exe, comm, maps, status, stat, statm, mounts, mountinfo, limits}`,
`/proc/{cpuinfo, meminfo, mounts, filesystems, version, uptime, loadavg,
stat}` and `/proc/sys/{kernel/*, vm/*, fs/*}`; the synthetic directories
answer `isDir`. `maps` matters most: glibc's `pthread_getattr_np` walks it
for the `[stack]` line containing the current stack pointer (Rust's
runtime and anything sizing the main thread's stack go through it), so
that line spans the guest stack and `[heap]` spans `brk`. `/dev/zero` and
`/dev/urandom` are generator descriptors (reads produce zeros or random
bytes, `mmap` of `/dev/zero` is anonymous, writes are discarded), and
`open("/proc/self/fd/N")` reopens descriptor N — a regular file with its
own offset, a pipe end shared — which is what bash's `<(...)` and `>(...)`
substitute. `tools/fixtures/procfs.c` (`procfs`) checks all of it with
output that is invariant across machines: cmdline equals argv, environ
carries PATH, maps has a `[stack]` containing a local's address, `[heap]`
and the executable, status names the program, `/proc/self/fd/N` reads the
same bytes as N, `/dev/zero` is zeros, `/dev/urandom` fills, and
`pthread_getattr_np` reports a stack containing a local — byte-identical
to native.

### Timers and signal descriptors — and a blocked signal's default action

`tools/fixtures/timers.c` (`timers`) closes the rest of the signal/timer
ledger, byte-identical to native: a one-shot `timerfd` whose `read` blocks
until expiry and returns 1; an interval `timerfd` that `poll` reports
readable; `signalfd` reading a blocked, raised SIGUSR1 as a
`signalfd_siginfo` with `ssi_code` SI_TKILL; `sigtimedwait` returning a
pending signal, and −1/EAGAIN with a zero timeout when nothing is pending;
a POSIX timer (`timer_create` with SIGEV_SIGNAL and a `sival`, `settime`)
whose SA_SIGINFO handler sees `si_code` SI_TIMER and `si_value` 77; and
`setitimer(ITIMER_VIRTUAL)` firing SIGVTALRM. The itimers are now three
slots (REAL/VIRTUAL/PROF — CPU time is modelled as wall time, since a
guest thread is always running while it is current), POSIX timers keep
overrun counts, and every armed timer is folded into the host-facing
deadline so a parked engine wakes for it.

**The bug this found was in the day-old signal code, not the new one.** A
`raise()` of a signal that is *blocked* and has no handler terminated the
process on the spot: `raiseSignal` applied the default action without
consulting the mask. The kernel leaves such a signal pending — for
`sigprocmask` to unblock later, or for `sigtimedwait`/`signalfd` to
consume — and applies the default action only when it becomes deliverable.
`raiseSignal` now terminates immediately only when the target thread has
the signal unblocked; otherwise it sets the pending bit, and the three
delivery checkpoints apply the default action (terminate, or discard for
the default-ignored set) when they find a pending, unblocked signal with
no handler. `signalfd`/`sigtimedwait` dequeue from any live thread's
pending set, carry the recorded `siginfo` across, and a blocked signal
still wakes a thread parked in one of them.

**Where a timer cannot fire.** Timers are checked at every syscall entry
(regardless of whether anything is pending — a compiled loop that makes
syscalls but never returns to the run loop would otherwise never see its
timer), after every compiled dispatch, and at the run-loop quantum. A pure
compute loop that never yields — no call, no syscall, compiled — cannot be
interrupted at all; the fixture's spin makes an occasional `getppid()`, as
a profiled program does. Asynchronous delivery into such a loop would need
a back-edge check in the compiled code, which is a translated-code-cost
decision, not a kernel-model one.

**And where the wall clock and the guest disagree.** Widening the timer
check to every syscall entry turned up one sweep failure: the `signal`
fixture's 20 ms itimer had already expired by the time the guest reached
`nanosleep(5 s)` — a tier-up compile between the two syscalls takes longer
than that — so the entry checkpoint ran the handler first and then let the
full sleep proceed (`ret=0`), where native, whose timer fires *during* the
sleep, returns EINTR. Both orders are legal; for a timer armed moments
earlier the second is the only one native ever shows. A timer that expires
as a sleep-like syscall is entered (`pause`, `nanosleep`, `sigsuspend`,
`sigtimedwait`, the poll family, `wait4`, `futex`) therefore counts as
interrupting that call — EINTR, or re-execution under SA_RESTART — while
for everything else the handler runs first and the syscall follows.

### Pids, mmap coherence, /proc listings

Three small entries from the ledger, one fixture (`tools/fixtures/procpid.c`,
`procpid`), byte-identical to native:

**Distinct pids.** `getpid` answered 1 in every engine. Each child engine
now carries the pid its parent's fork assigned and the parent's pid as
`ppid` (a tail-exec keeps its own identity), and a fork child still inside
its vfork window answers with its own pid while it is the current thread;
`kill`, `/proc/self/status` and `/proc/self/stat` use the same numbers. So
the child's `getpid()` equals what `fork()` returned in the parent and its
`getppid()` equals the parent's pid.

**mmap coherence.** A file written through a descriptor after being mapped
did not change the mapping, and a store through a shared writable mapping
was invisible to `read()` until `msync`/`munmap`. Now a descriptor write
(`write`, `pwrite`) lands in every live mapping of the path that overlaps
the written range, and a descriptor read (`read`, `pread`) of a path with
shared writable mappings first copies those mappings back — both
directions are coherent without an explicit sync, as on Linux where they
share the page cache.

**/proc listings.** `dirEntries` adds the synthetic tree, so `ls /proc`,
`/proc/self`, `/proc/self/fd` (the open descriptors), `/proc/self/task`
(live threads), `/proc/sys/*` and `/dev` enumerate what `_synth` answers.

### Breadth from the outside: nine programs, four gaps

With the kernel ledger closed, the next gaps had to come from programs
that lean on it from the outside. Nine new cases: coreutils `timeout`
(SIGALRM then SIGTERM to its child, exit 124), a bash script with `trap`
and `kill -USR1 $$`, Python `multiprocessing.Pool` (fork children that
never exec, blocking on pipes and semaphores), Python `setitimer` +
`time.sleep` (PEP 475 retries the interrupted sleep), a FIFO with a
background writer and a blocking reader, `xargs -n1` and `find -exec`
(fork storms), threaded `xz -T2`, and `ls -l` on a real tree. Five passed
untouched; four found something:

**Hard links.** `link`/`linkat` were ENOSYS, which is what stopped
`multiprocessing`. A hard link is now one buffer under two names: the
alias group lives in the fs metadata, a write that grows the buffer
refreshes every alias, `nlink` is the group size, and `unlink` drops a
name from its group.

**FIFOs.** `mknod`/`mknodat` with S_IFIFO create a named pipe buffer; an
`open` returns an ordinary pipe handle (so EOF, SIGPIPE, capacity and
readiness all come for free), a writer's open clears EOF, O_NONBLOCK
readers proceed and writers get ENXIO. The first run deadlocked on the
classic rendezvous: each side's blocked open waited for the *other's
handle*, which only a completed open creates. The FIFO keeps a registry
of waiting openers, and an open completes when the other end is open or
merely waiting — the writer here is a fork child that blocks in `open`
(and is therefore materialised), the reader is `cat`, and both complete.

**`ls -l` fidelity.** `ls` printed "Function not implemented" because the
xattr family answered ENOSYS; `getxattr`/`removexattr` now answer ENODATA,
`listxattr` an empty list, `setxattr` ENOTSUP. Then the columns: `st_blocks`
is now in 4K allocation units (it was `size/512`, so `total` and `du` were
wrong), a directory's `st_nlink` is 2 + its subdirectories, and the harness
provisions directory mtimes (it recorded only files). The remaining
difference was the `..` entry — the host's own `/tmp` with 1089 links —
so the case lists without `-a`.

**Not a bug.** `find -exec` prints in readdir order, which is
filesystem-dependent natively; the case sorts.

### Second batch from the outside: eight programs, two gaps

`patch` (a unified diff applied to stdout), `flock` (an advisory lock,
then `sh -c`), a `tee` pipeline, `sort -S 1K` (external merge through temp
files), Python `subprocess.run` (posix_spawn, pipe capture, wait), Perl
`fork`+`waitpid`, bash process substitution (`diff <(…) <(…)`), and
`env -i`. Six passed untouched; two found gaps:

**flock.** ENOSYS. Advisory locks now live in the shared fs metadata,
keyed by path, per open file description: LOCK_SH/LOCK_EX/LOCK_UN, LOCK_NB
answering EWOULDBLOCK, otherwise the caller blocks and re-checks; a close
(and `close_range`) releases what the description held. POSIX record locks
through `fcntl` were still always granted at this point, with F_GETLK
reporting F_UNLCK instead of echoing the caller's own request type back
(which reads as "locked by someone"); they became real later (see
"Record locks, SIGEV_THREAD, and the mask a thread is born with").

**/dev/fd.** bash substitutes `/dev/fd/63`, not `/proc/self/fd/63`; the
reopen path now serves both, plus `/dev/stdin`/`stdout`/`stderr`, and
`/dev/fd` lists the open descriptors. `close_range` (Python's subprocess
uses it) closes or marks close-on-exec a range of descriptors.

### Third batch from the outside: six programs, three gaps, one open

GNU `make` (a dependency graph with recipes through `/bin/sh` and an
up-to-date check), an awk program file, `tar` extracting directories and a
symlink then `find`/`readlink` over the result, Python threads with a
`queue` and a lock, Ruby `fork` + `Process.wait`, and `git init`/`add`/
`commit`/`ls-tree` in a fresh repository. Three passed untouched; three
found gaps:

**posix_spawn is `clone(CLONE_VM|CLONE_VFORK|SIGCHLD)`.** `make` runs
every recipe through it, and the clone handler routed anything with
CLONE_VM to the *thread* branch, so the recipe ran as a thread of make
and make's `wait` found no children. CLONE_VFORK now decides: such a
clone is a vfork-window child on the caller-supplied stack (posix_spawn
allocates a small one), not a thread. Python's `subprocess` passed
earlier only because CPython calls `vfork()` directly.

**`symlinkat` ignored its directory fd.** The link name was resolved
against the cwd, so tar (which extracts through an O_PATH fd on the
parent directory) created the link one level up; every later attribute
operation through the dirfd found nothing. Along the way: `fchmodat2`
(452) answered ENOSYS, sending tar down an O_PATH+`/proc/self/fd` fallback
for every entry — it is now answered like `fchmodat` (modes are not
modelled) — and `utimensat` accepts symlink and FIFO paths.

**Open: Ruby fork.** `fork { puts …; exit 4 }` under the engine never
finishes: both runner and harness spend their iteration budgets sleeping
on Ruby's timer thread's timed waits, and whether the child deadlocks
(a lock whose owner is the parent's *other* thread, copied into the
child's image) cannot be told without a syscall trace of the child
engine — the runner traced only the root engine. It now arms every child
engine's ring as it appears, and the trace changed the picture: the child
*finishes* (prints, exits) — it is the **parent** that dies, at rip 0, in
its timer thread.

**fork() in a multithreaded parent freezes the siblings.** Ruby's child
runs `atfork` cleanup that tears down the *other* threads' structures.
In the vfork window that memory is shared with the parent, and the
parent's other threads kept running on the torn-down state before the
journal rolled it back — the timer thread resumed into garbage. The
window now freezes every sibling thread of the forking parent (their real
state is kept and restored on release: exec, exit, or materialisation),
which is what fork's atomic-snapshot semantics require; a child that
blocks still materialises and releases everyone.

**Materialisation copies live ranges, not memMB.** With siblings frozen,
`multiprocessing`'s workers block at once (nobody feeds their pipes during
the window) and all materialise — and the copy touched every byte of a
1GB image per worker, so the harness was OOM-killed copying zeros. The
copy is now program+heap up to `brk`, the mmap arena, any MAP_FIXED spans
outside it, file mappings, and the top 64MB of the stack; untouched pages
are never committed. `python-mp` went from 105s to 72s.

**Resolved: a window child's threads are the child's.** A standalone
isolation script (construct, then short `run` slices with counters and
RSS) showed two things at once. The "hang" was slowness: the first slice
alone took 111 s — Ruby's startup plus tiering 1,400 functions through an
uncached `wat2wasm` — and the 5 GB of RSS was the runner's provisioned
libraries, not the engine. And the thread table after the fork showed the
real bug: thread 3 running, unfrozen. It was the *child's* new timer
thread, created by `clone` inside the vfork window — and the thread branch
attached it to the parent (no `proc`). When the child materialised, that
thread stayed behind in the parent, running the child's code on
rolled-back memory: rip 0.

A thread cloned by a window child now inherits the child's `proc`, so it
runs with the child's fd table and journal, is not frozen with the
parent's siblings, migrates into the child engine at materialisation
(its CPU state copied alongside the memory), and dies with the child on
`exit_group` or `execve`; a plain `exit` of one such thread is a thread
exit, not the process's. `ruby-fork` prints `child` / `parent 4`,
byte-identical to native.

**Then it hung under the sweep only.** In isolation the case passed; under
`breadth.mjs`, with compiled units already cached, the parent sat in
`wait4` and the child engine never exited, each host iteration advancing
about 130 interpreted instructions. The child's syscall tail (a traced
parent now arms its children's `strace` rings, and each line carries its
thread id) named it: thread `[1]` did `epoll_wait`, `read`, `madvise`,
`exit(60)` and died; thread `[1000]` wrote a byte to the wake-up pipe and
blocked on a futex it never left. Thread 1000 was the child's *main*
thread joining its timer thread; thread 1 was the timer thread. Cached
units change the interleaving so that inside the window the timer thread
blocked first — and materialisation had built the child engine's
`threads[0]` from the constructor's blank record, copying only the
blocking thread's CPU state and signal mask. Its `ctid` — the address
`pthread_join` waits on, which `set_tid_address` had recorded — was lost,
so the timer thread's exit cleared nothing and woke nobody. Whichever
thread blocks first now carries its whole identity into `threads[0]`:
tid (the one glibc cached, `gettid` must agree), `ctid`, pending signals,
alternate stack. And pids come from one counter at the root of the engine
tree, so a materialised child that forks cannot hand out its own pid
again.

### Fourth batch from the outside: seven programs, one gap

`m4` (recursive macros, `eval`, `regexp`, `esyscmd` forking a shell inside
a filter, diversions), `bison` generating an LALR(1) parser from a grammar
(41 KB of output byte-compared to native's; it runs its skeletons through
an execve'd `m4`, which the case must provision itself — run alone it
failed with SIGPIPE on m4's ENOENT until it did), `vim` in silent ex mode
(a substitution, a filter through `sort`, a write), `ninja` dry-running a
five-edge build graph, `cmake -P` (script mode: lists, math, regex, file
write and read-back), `gdb -batch` looking up and disassembling `main` in
a real binary, and `split` cutting the input into numbered pieces. m4,
bison, ninja, split passed untouched. Two wanted more of the system
provisioned — harness omissions, not engine gaps: cmake its module tree
(`/usr/share/cmake-3.28`), and vim the shell its filter runs through.
Vim's child execs `/usr/bin/sh` by absolute path (its compiled-in
`shell`), so `/bin/sh` alone does not serve it; with ENOENT the filter
produced nothing, the buffer emptied, and `w!` wrote an empty file with
exit 0 — a silent wrong answer, which is why every case byte-compares its
output rather than trusting the exit code. gdb embeds CPython and
initialises it at startup, so it needs the stdlib tree like the python
cases do; it also asked two things the surface lacked, `getrusage`
(zeros now) and `faccessat2` (answered like `faccessat`). vim found the
one real gap:

**`fsync` was ENOSYS, and vim treats a failed fsync as a failed write.**
Its write path is open, write, `fsync`, close; on the error it reports
`E667`, exits 1, and — with `writebackup` on — deletes the file it had
just written, leaving nothing to compare. `fsync`, `fdatasync`, `sync`,
`syncfs` and `sync_file_range` now return 0: the file system lives in
memory, so everything is already as durable as it will ever be.

### m4 at 250x native: the translator refused every function above a PLT stub

The first steady-state measurement of the new batch never finished: m4 on
a 13 MB macro input took over twelve minutes per run against 2.9 s
native. The profile said why in two numbers — 253 M interpreted
instructions and 15 M compiled-unit entries on a 50 k-line input, seventeen
interpreted instructions per entry: the hot path was bouncing between
compiled callers and one interpreted callee. The hot rip was the prologue
of m4's input reader (`peek_input`, `push rbp; mov rbp, rsp; ...`), and
the runner's new tiering dump (`DUMP=rip`) said it was in `aotFailed` with
the reason `trampoline -> callout` — a check meant for PLT stubs, refusing
a plain function.

The check read `an.blocks[0]` as the entry block. `analyze()` sorts blocks
by address, and this function's CFG reaches a block *below* its entry — a
tail jump into a PLT stub at 0x404b90 — so `blocks[0]` was that stub
(`nop; jmp *GOT`), and the function was classified as a trampoline. The
"entry undecodable" check had the same bug. Every function whose control
flow touches a lower-address stub was refused, permanently: thirty-two of
m4's own functions, its whole input path. Both checks now use the block at
the entry address (`bidx`). On 10 k lines m4 went from 139 s to 28.5 s,
interpreted instructions from 126 M to 28 k. Steady state by two-size
subtraction (`bench/vsnative.mjs`, 20 k vs 200 k lines): **8.4x native**
(20.7 s vs 2.46 s of work) — m4 is now in the call-dense band with perl,
a `getc`/`ungetc` per character through the PLT, no longer off the chart.

Steady state of the batch so far, engine work over native work by the same
subtraction (startup share in the engine's big run in parentheses — above
50% the resolution is poor and the number is an upper bound):

| binary | work | engine | native | ratio |
|---|---|---|---|---|
| m4 | 200k macro lines | 20.7 s | 2.46 s | **8.4x** (27%) |
| cmake -P | 60k-iteration script loop | 11.5 s | 8.7 s | **1.3x** (51%) |
| vim -es | `%s` + write over 1.2M lines | 7.6 s | 1.34 s | **5.7x** (43%), after the write fix below; 14.8x before it |

cmake is near native — its work is C++ string and list code, large
functions, little call tax. vim is the outlier and the next profile.

### vim's 14.8x was the file write, quadratic

The vim profile said nothing was interpreted (85 k instructions in a run
of billions, 2,800 unit entries) and syscalls were few (under 300). The
V8 profile of the run said where the time was: `writeChunk` — the engine's
own `write(2)` — at 3.4 s of a 6 s steady state. Its regular-file path
grew the file by allocating an exact-length array and copying the whole
file on every append past the end: 8 KB writes of a 14 MB file copy
12 GB. Native vim's write is 30 ms. The file array is now an exact-length
*view* over a backing buffer that doubles (`_growFile`, shared by `write`
and `pwrite64`); every consumer already takes the view's length and
byteOffset, so the spare capacity is invisible to readers, `mmap`, and
the ELF parser. The sweep's file-writing cases (compilers, tar, tee,
bison, split, bigheap) are the regression net. vim's steady state halved,
6.2 s to 3.1 s — 7.5x native at poor resolution (startup 77% of the big
run); on a 1.2 M-line input, where the work is 43% of the run, **5.7x**
(7.6 s vs 1.34 s), in the call-dense band with m4 and perl.

### Inside the call-dense band: what m4's 8.4x is made of

With everything compiled, the remaining question is what the compiled
code spends its time on. `bench/realab-run.mjs` now assembles with
`--debug-names`, so a V8 CPU profile of the cached steady state names
guest functions: on 200 k macro lines, m4's tokenizer `next_token`
(0x40fe70) takes 4.9 s, its per-character helper `peek_input` (0x409e80)
2.3 s, four small m4 helpers 1–1.6 s each, `memcpy` 0.8 s — and the
engine's own JS under 1 s: the JS boundary is not where the time is.
Three probes, each a null or near-null, narrow what is:

- **More inlining.** `next_token` has 44 call sites to `peek_input`,
  `next_char` and an obstack helper; the inliner's 640-instruction
  per-function cap covers a fraction of them. A 4x cap
  (`OXWASM_INLINE_TOTAL=2560 OXWASM_INLINE_BUDGET=256`): **1.036x, inside
  ±5%**. The calls it makes are not the cost.
- **V8's loop stack checks.** 40 of the unit's 95 functions use the
  dispatch (br_table) layout, which wrapped every block body in a `loop`
  so that self-edges could branch directly — 11,772 loop headers for 112
  self-edges, each header a stack check. `--no-wasm-stack-checks`:
  one pair read −28%, the next −2%; the first was a warm-up artifact. The
  emitter now wraps only blocks that actually branch to themselves
  (`OXWASM_BLOCKLOOPS=1` keeps the old shape for A/B). The dispatch
  differential is 400/400 bit-exact with the new shape; the steady-state
  A/B was interrupted by container restarts three times and not
  completed — its ceiling is the −2% the stack-check probe bounds it by.
- **Function bloat from noreturn calls.** `peek_input` is 40
  instructions; its translation is 4,500 lines. The analyzer follows a
  call's fall-through, and after `call abort@plt` that is the next
  function — which it swallows, along with everything that function tail-
  jumps to: the analysis spans 608 instructions from 0x407b30 to
  0x4306a8. The unit is 27 MB of WAT for 95 functions. The analyzer now
  cuts the fall-through when the next address is a known function entry
  (one the profile has seen called, or one already compiled; the block
  ends in the call and a never-taken deopt). A static marker such as
  `endbr64` was considered and rejected: CET also marks jump-table case
  labels, and a switch case falling through a call into the next case
  would be cut on a hot path. Honest limit: the neighbour `peek_input`
  swallows is an error-path function nothing ever calls, so the dynamic
  cut does not fire there and that unit's size is unchanged; the cut
  helps where the neighbour is live code (the common `__stack_chk_fail`
  epilogue before a hot function). A translator-level answer for the
  rest — treating a tail `jmp` into another function's entry as a call
  rather than following it, and a symbol-based noreturn list — stays
  open. Dead code costs compile time and register allocation rather than
  steady-state cycles, so this is a size fix first.

What none of the probes touched is the per-call protocol itself: every
call site spills 16 GPRs and 8 xmm registers to the regfile and reloads
them after (`v128.store`/`v128.load` ×8 each way), and every callee
reloads at entry and spills at exit — a fixed ~64 memory operations per
call, which for a per-character helper is the whole function. Reload
narrowing measured as a null on perl, and the xmm half is now priced the
same way: `OXWASM_NOXMMCALL=1`, a probe that drops the eight `v128`
stores and loads from every spill and reload site (unsound for calls
passing floats; the A/B checks the output hash), reads **0.956x, inside
±9%** on m4. The whole regfile protocol — GPR and xmm, spill and reload —
is not where the 8x lives.

That leaves the translated instructions themselves, or V8's treatment of
them. The unit's hot functions are 4,000–6,000 lines with 40-plus
locals, so whether V8 ever tiers them from Liftoff to TurboFan was the
next probe. It does: `--liftoff-only` is 1.7x slower end to end
(44.7 s vs 26.3 s), and `--no-liftoff` (TurboFan for everything, up
front) has the same steady state as the default by two-size subtraction
(20.8 s vs 19.1 s, the difference inside noise) while paying 4.5 s more
compile time. The default's steady state is TurboFan code already.

So every layer above the instructions is priced: calls and inlining,
the regfile protocol in both halves, dispatch, stack checks, tiering.
What is left is what TurboFan makes of the emitter's patterns for
branchy byte-scanning code — a compare and a conditional branch per
character, byte loads through wrapped 64-bit addresses, lazy flags in
three locals. The ideal-kernel method (`bench/kernels/`) priced calls
and memory at 1.4–2x on straight-line loops. A tokenizer-shaped kernel
(`scan`: one byte per iteration, a chain of four class compares with
sub-width `cmp $imm,%cl`, three counters, a masked index — gcc's own
code for it, run through the real emitter) measures **3.80x**, against
`alu` 3.03x and `branch` 1.94x on the same run. So the shape alone is
nearly half of m4's 8.4x; the rest is what the real function adds —
calls (priced null one layer at a time, but the kernel has none), and
6,000-line bodies whose register allocation TurboFan does over 40
locals. `idealmem`'s method on this shape splits the 3.8x: the
emitter's exact WAT for the loop, lifted verbatim from the unit dump into
a standalone module, runs at **0.86x native** (faster than gcc's -O1
code), and a hand-written ideal at 0.88x — faithful/ideal 0.99x. The
emitter's patterns are not the cost: lazy flags in three locals,
width masks, wrapped addresses all compile to native-speed code when
the function is small. The same loop inside the engine's unit is 3.8x.
The difference is the CONTEXT the loop is compiled in — a 1,000-line
function with 60 locals and 67 blocks, the engine's memory — and the
experiments vary it one factor at a time. Eight more guest registers
live across the loop (`LIVE=1`): 0.87x — not register pressure. The
engine's memory is not shared and 4,096 pages is inside V8's guard-page
regime, so not that either. The remaining difference is dynamic: in the
kernel binary `main` enters the loop once and never returns until the
run ends. V8 compiles a function with Liftoff first and tiers it up in
the background, but a frame already running baseline code keeps
running it unless the loop is replaced on the stack. `--liftoff-only`
on the scan kernel reads **3.65x** — the default's 3.80x within noise.
The default run IS the baseline tier for this loop: V8 tiered `main` up
in the background long ago, but the frame that entered the loop first
never returned to pick the new code up. (This Node's V8 exposes no wasm
OSR flag; its tiering is budget-driven and replaces code for the *next*
entry only.) The decisive pair, by two-size subtraction on the runner
(400 M minus 100 M iterations): default tiering **2.2 s**, TurboFan from
the start (`--no-liftoff`) **0.33 s** — 7.4 ns against 1.1 ns per
iteration, native 1.5 ns. The compiled loop is not slow; the frame that
runs it never gets the compiled code.

### The loop yield: a frame hands its loop head back

The fix is the engine's, not V8's: give a long-running compiled frame a
way to return. Every backward edge in both emitter layouts now burns one
unit of a loop budget (`FTLOOP`, a word in the FTMAP header's dead
space, refilled per dispatch from `eng.loopYield`, default 4 M edges);
at zero the frame spills its registers and *returns the loop head's
address as its exit rip* — the contract a guest `ret` already uses, so
nothing new is needed on the engine side: `dispatchAot` treats the rip
as the resume point, the interpreter profiles the back edge, the loop
head becomes its own unit after twelve iterations, and every re-entry
from then on runs whatever tier V8 has compiled by then. A yield every
4 M edges costs one JS round-trip (a regfile sync each way) per ~10 ms
of loop, well under 1%. Correctness rests on the same ground as a
deopt to a loop head: the frame's stack stays in place, the registers
are in the regfile, and execution resumes at a guest address.
`OXWASM_LOOPYIELD=0` (or `globalThis.__loopYield = false`) turns the emission off for A/B; it is on by default (it shipped off for one commit while its cost was bisected; see below). One detail that
mattered: the edge burns first and tests for exactly zero, so a budget
nobody armed (a unit function called outside `dispatchAot`, as the
differential tests do) wraps and never yields — the test-then-burn
draft made every first back edge an exit and read 10/400 on disptest.

By the same two-size subtraction, yield on: 300 M iterations in
**0.95 s** (168 dispatches, 75 of them yields), against 2.2 s without
and 0.33 s for TurboFan-from-the-start — the frame now reaches tiered
code partway through, and what remains is the Liftoff time before each
loop head's own unit is tiered. On the kernel harness — the number that
started this — `scan` goes from **3.86x to 1.15x native** (yield off vs
on, same run, ±1%; the harness recalibrated N to 4.1 G iterations as the
engine sped up). `alu` and `branch`, whose loops the harness also enters
once, are the next re-measurement, and every program whose hot loop is
entered once and never returns — a compressor's main loop, a checksum,
a sort — is the population this applies to. m4's tokenizer, called per
token, was reaching tiered code already; its 8.4x is still the
per-call-frame story, now with the loop-yield effect separated from it.

The other kernels, yield off → on, same run: `branch` 1.94x → **1.35x**,
`subw` 5.29x → **2.80x**, `alu` 2.95x → 3.02x, `mem` 2.43x → 2.46x,
`muldiv` 1.60x → 1.57x. Two of five were baseline-tier loops too; the
three that did not move were already reaching tiered code (their loops
call out or exit often enough), and the yield costs them nothing.

**And m4 diverged.** The realab A/B of m4 on 200 k lines with the yield
on exited 2 with different output. The sweep's m4 case is 86 bytes and
never reaches a yield; the big input does, and the yield was unsound
for one frame kind: an in-unit call site `(drop (call $f_x))` drops
its callee's returned rip and continues after the call — the frame
protocol for a *nested* wasm call, where the callee's rip is only
meaningful as "my frame exited normally". A callee that yielded
mid-loop returned early, its caller carried on past the call with the
callee's frame still on the guest stack, and m4 walked off. The yield
now fires only in a frame whose returned rip is honoured: every in-unit
call site bumps a nesting word (`FTNEST`) around the call, each
dispatch (`dispatchAot`, the drive loop, a nested dispatch from a
callout) zeroes it for its own frame and restores it after, and the
back-edge check tests it before returning. Nested frames simply keep
running — they are short-lived by construction, being callees.
With the nesting rule m4 on 200 k lines is exit 0 with the output hash
identical to native, and the dispatch differential stays 400/400.

**And the sweep ran past its 90-minute cap.** 116 cases passed, none
failed, but `gdb-batch` took 1,068 s where it had taken 271 s and
`python-mp` 619 s where it had taken 72 s. A yield hands a loop head to
the engine; when no unit is rooted there, the interpreter runs the
loop, its back-edge profile tiers a *new* unit at that head after
twelve iterations — a whole closure translation and an assembler run —
and a big program has hundreds of hot loops entered once. The rule is
now: yield only to a head that already resolves in the funcref table.
The back edge probes `$ftr` once the budget is spent; on a hit the frame
returns the address and `$drive` chains into the loop-head unit in
wasm, no interpreter and no compile; on a miss it refills the budget
and keeps running. Hot loops the interpreter ever ran already have
their loop-head unit (that is how the scan kernel's `main` was
compiled in the first place), so the case that matters still yields,
and the rest costs one hash probe per 4 M edges. Except that the
assumption was wrong where it mattered most: the scan kernel's loop
head never had a unit — the frame running it was compiled from a
different root — and with the probe alone the kernel read 4.28x again,
the whole win gone. So a miss now does one more thing: it calls
`env.loophot(head)`, and the engine roots a unit at that head, once
(`_loopHot`, a set of heads already asked for). No interpretation, one
bounded compile per loop that has run 4 M edges without a unit of its
own; the next expiry's probe hits and the frame chains into it in wasm.
The storm case is bounded the same way: gdb's hundreds of loops each
cost one compile only after 4 M back edges, not after twelve interpreted
iterations.

**The nesting rule then lost the kernel a second time.** With the unit
rooted and the probe hitting, the scan kernel still read 4.8x: its
`main` is called by libc's `__libc_start_call_main` from *compiled*
code, so it is a nested frame — as is any hot function called from
main — and nested frames never yielded. The rule was right about what
a nested frame may not do (return early past a caller that drops its
rip) and wrong about the remedy. A nested frame now takes the other
exit the emitter already has: it deopts to the resolved loop head. The
engine's `interpUntil` dispatches the loop-head unit *under* the
frame, runs it to the frame's own exit (rsp above `rsp0`), and returns
that rip to the wasm caller, which continues past its call site exactly
as if the callee had returned. One JS round trip per 4 M edges, and no
growth in nesting: the loop-head unit's own yields are top-level within
that dispatch. Top-level frames keep the cheaper return-the-head path.

Measurement discipline for this stretch: the numbers taken while the
three slow sweep cases were re-running on the same CPU came out about
2x slower in every configuration, including TurboFan-only, and were
discarded; the engine now counts the yields it takes (`loopYieldTop`
for the return path, `loopYieldNested` for deopts to a loop head,
`loopHot` for units rooted on request), so a clean two-size run reports
whether the mechanism fired and how, not just how long it took.
The first counted run said: on 100 M iterations of the scan kernel,
`loopHot` 1, `loopYieldTop` 1, `loopYieldNested` 0 — one unit rooted at
the head on request, one yield through the engine, and from then on the
loop-head unit hands its head to `$drive`, which chains back into it
without leaving wasm; the JS-side counters see nothing more, which is
the design working. (A comment that swallowed the deopt handler's first
statement made every deopt a ReferenceError for one measurement round;
those numbers were voided too.)

The clean run then read the one thing the counters could not: yield on,
300 M iterations in **3.0 s**; yield off, **1.2 s**; TurboFan-only,
1.2 s. Worse with the mechanism than without. The cause is in the
hand-off itself: after the first yield the loop-head unit hands its head
to `$drive`, which chains straight back into it in wasm — and nothing
on that path refills the loop budget, which `dispatchAot` alone had been
filling. The second entry started with the word at zero, burned it to
2^32−1, and ran baseline code for the rest of the run: the original
problem, moved one frame over. The yielding frame now refills its own
budget before it returns, so every re-entry — through `$drive` or
through the engine — gets a full budget and yields again in turn.
With that, the scan kernel on the harness reads **1.53x native**
(±2%; 3.86x without the yield). The unsound first version read 1.15x;
the difference is what soundness costs here — a nested frame's yield
is a deopt round trip through the engine rather than a return, and the
head's unit is compiled on request rather than found — both bounded,
once per long-running loop and once per 4 M edges.

**And the sweep ran past its cap a third time — with zero yields.** The
per-case counters said `yields=0/0/0` on every slow case (gdb-batch at
the 900 s wall, python-mp 495 s, bison 209 s, m4's 86-byte case 60 s
where it takes 9), so the mechanism never fired; the cost was the code
it added. Each backward edge carried its whole exit inline — the full
register spill, thirty-odd lines, inside a branch never taken — and a
big function has thousands of back edges: the units grew enough that
V8's compile of them, and the code it produced, took the sweep down
4–7x with nothing yielding. The exit is now emitted once per function,
a `$yield` block wrapping the body: a back edge whose budget is spent
and whose head resolves sets `$rex` and `br`s there, and the spill,
refill, and return-or-deopt live in one place. A back edge costs a
burn, a test and (once per 4 M edges) a probe.
m4's sweep case under the shared exit: 39.8 s on the one-time
recompile, **6.7 s** cached — where it was before the yield existed.
The scan kernel under it: **1.56x** (1.53x with the per-edge exit —
the same within noise; the shared exit changed the code size, not the
hot path).
m4 on 200 k lines under this rule: exit 0, output hash identical to
native, 29.9 s wall against 45.7 s with the unconditional yield (both
uncached). One consequence for the test rig: any function with a loop
now imports the funcref table for the probe, so the twenty
differentials that instantiate hand-made snippets with stub imports
supply an empty table (every probe misses, the snippet's own loop runs).

**A fourth cap, still with zero yields — and the same cap with the
yield off.** The full sweep with the shared exit was killed at 90
minutes once more, every case at `yields=0/0/0`: gdb-batch 898 s
against 271 s, gcc-link 428 s, python-mp 444 s against 72 s, bison
156 s against 50 s. To bisect, the whole mechanism went behind a gate
(`OXWASM_LOOPYIELD=1`, or `globalThis.__loopYield`): off, the back
edges, the call-site nesting stores and the `$yield` exit are not
emitted. The sweep with it off was killed at the cap too — gdb-batch
1081 s, python-mp 600 s, bison 178 s, m4 48 s — so the emitted yield
code was never the cost. The harness caches assembled units by the
SHA-1 of their text, and the one line every unit now carries, the
`env.loophot` import, had changed every text: 20,983 fresh entries
were written during the off sweep, and m4's case alone is 39.8 s on a
recompile against 6.7 s cached. Every "slowdown" above was a cold
cache, on and off alike (on was in fact the faster of the two). The
90-minute cap assumes a warm cache; a build that touches every unit's
text pays one cold sweep before it can be gated. (The cache had also
grown to 9.8 GB of entries no current text can hit; pruned to the
live 2 GB.) (And the next on-sweep was killed at case 90 by the memory cgroup, not
the cap: the sweep process runs at up to 9.6 GB, every extra engine
instance is another ~4 GB of RSS, and the container has ~15 GB - a
two-case harness run alongside it was enough. Nothing runs beside a
sweep, not even a "light" case.) The gate stays for A/B, and the FTLOOP/FTNEST words,
`env.loophot`, the counters and the differential stubs are emitted
regardless, so on/off is one environment variable.

**Back on by default.** The on-sweep, run alone, is 130/130
byte-identical (the two new fixtures included), and its counters say
what the sweep can and cannot show: not one case reaches a yield -
none runs a single loop for 4M back edges - so the sweep is a
correctness gate for the emission and no measure of it. Its timings
against the off-sweep are noise dominated by which units happened to
be cached (php 8 s against 62 s one way, m4 49 s against 28 s the
other). The measure stays the kernels and the long runs: scan
3.86x -> 1.56x, branch 1.94x -> 1.35x, subw 5.29x -> 2.80x. The
default is `OXWASM_LOOPYIELD=0` to turn it off.

### The heap walked into the mmap arena: vim on a 14 MB file

The vim measurement never produced a number either: on a 400 k-line input
the engine faulted reading address 0x59 — and only at `q!`, after the
file had been written correctly. The runner's crash report (the ELF image
holding rip, walked down page by page to its header and matched against
the provisioned files; the last interpreted rips) put it in `ld.so` at
`_dl_fini`, walking the link-map chain: `cmp %rax,0x28(%rax)` with an
`l_next` of 0x31 — an ASCII `1`, the input file's own text.

The heap had overwritten ld.so's first mmapped pages. The break started
above the loaded images and the anonymous-mmap arena 64 MB above *that*,
and `brk` enforced only the end of guest RAM: a heap past 64 MB grew
straight through the arena, where ld.so's minimal malloc had put the
link maps (and where libc, TLS and everything else mmapped early live).
A 2 k-line file never got there; 14 MB of text plus vim's memline and
undo did. On Linux the break stops at the first mapping in its way and
glibc's malloc carries on from mmap; the engine now does the same — the
break refuses to cross the arena base (answering with the break
unchanged, which glibc reads as ENOMEM and turns into `mmap`), and the
gap is a quarter of guest RAM, at least 64 MB. A `bigheap` sweep case
(160 MB in 64 KB pieces on a 512 MB guest, every byte verified) crosses
the 128 MB gap and takes the fallback: 361 `brk` calls, the tail of them
refused, exit 0 byte-identical to native.



**The one bug that stood between compile and link was in `read`, not the
linker.** The full link completed and produced a structurally perfect ELF,
but `ld` left **`_start` zero-filled** (0x1060–0x1085, the 38 bytes from
`Scrt1.o`) while every other object linked correctly. The section-copy of
`_start` landed at file offset **1036 instead of 4192**. The trail:
`glibc`'s buffered stdio, about to write a partial block of the still-sparse
output file, first `read`s a block ahead at offset 4096 — but the file was
only 940 bytes long at that moment. The engine's `read` computed
`n = min(count, bytes.length − pos) = min(count, 940 − 4096) = −3156`, a
**negative** short-read count, then did `h.pos += n` and **rewound the file
position** from 4096 back to 940. The next `lseek(SEEK_CUR, +96)` — glibc
seeking to the section's write offset relative to where it believed the
position was — therefore landed at 1036, and `_start`'s bytes were written
there. A real kernel `read` at or past EOF returns 0 and leaves the position
untouched; the fix is a single `Math.max(0, …)` clamp on the read count
(`pread64` already had it). A position-only corruption in the most basic
syscall, surfaced only by a linker writing a sparse file through glibc's
block-buffered stdio. `pwrite64` (nr 18) was ENOSYS and is now implemented
too (honouring its explicit offset without moving `h.pos`), though this
`ld` reached `_start` through `lseek`+`write`, not `pwrite`. Repro:
`scratchpad/trylink.mjs`.

### Record locks, SIGEV_THREAD, and the mask a thread is born with

Two of the listed correctness gaps closed while the yield sweeps ran,
each pinned by a fixture whose native output the breadth harness
compares against (`tools/fixtures/rlock.c`, `sigevthread.c`).

**POSIX record locks.** `fcntl` F_SETLK/F_SETLKW/F_GETLK and the OFD
trio were granted unconditionally: two processes contending for a lock
file both won, and F_GETLK always answered F_UNLCK. They are now byte
ranges in the shared fs metadata (`_fsMeta().rlocks`, keyed by path),
so a fork child - its own engine over the same file store - sees the
parent's locks. A POSIX lock is owned by the process and dropped when
*any* fd on the file closes (the classic trap, reproduced by the
fixture: the parent unlocks by opening and closing a second fd); an OFD
lock is owned by the open file description - the handle object dup and
fork share - and dropped with its last fd. Conflicts are by range and
type (two readers coexist, a writer excludes), F_SETLK answers EAGAIN,
F_SETLKW parks the thread with a 20 ms deadline and re-checks (every
blocking syscall re-executes on wake), F_GETLK describes the first
blocker with `l_pid` (-1 for an OFD lock, as Linux reports). The one
subtlety was identity: a child that takes a lock *inside its vfork
window* is still a thread of the parent engine, owned by its proc
record; when its F_SETLKW blocks, the scheduler materialises it into
its own engine, and its identity became that engine - it then
conflicted with its own earlier lock and spun forever after the parent
unlocked. Materialisation now re-owns the proc's locks to the new
engine. Locks die with the process (`exit_group` and the window-exit
path both release the owner's).

**SIGEV_THREAD timers** were refused with EINVAL. glibc never sends
SIGEV_THREAD to the kernel: it starts a helper thread with every
signal blocked around the `pthread_create`, asks for SIGEV_THREAD_ID
delivery of SIGTIMER (signal 32) to that thread, and the helper
`sigwaitinfo`s and starts a thread per expiry for the callback. So the
engine needed thread-directed timer delivery (`notify === 4`, the tid
at sigevent offset 16, validated against the live threads), and it
needed the thing that actually broke: **clone never copied the
creator's signal mask** into the new thread. The helper started with
an empty mask, SIGTIMER was "deliverable, no handler", and the first
5 ms tick applied the default action - the whole process died with
exit 160 (128 + 32). Both clone sites now inherit the mask as Linux
does (pending cleared; the alternate stack copied across fork but not
into a thread). The fixture's callback fires three times in 15 ms and
the process exits 0 with 29 dead callback threads behind it.

Still open from that list: `mprotect` is a no-op (a guard page never
faults, so a runtime that probes its stack limit by touching it will
not see the SIGSEGV it expects), and mremap grows only by moving: a
grow without MREMAP_MAYMOVE answers ENOMEM even when the pages after
the mapping are free.

### Bounding a function at its tail calls

The other half of the function-bloat item: gcc's sibling-call
optimisation ends a function with `jmp callee`, and the analyzer
followed that jump as if it were a branch, decoding the callee and
everything *it* tail-jumps to into the caller's unit. The noreturn
cut (above) stops the fall-through after `call abort`; this stops the
walk at a direct `jmp` whose target is a known function entry - one
the tiering profile has seen called or one already compiled - and not
already part of this function's own decoded range (a jump back to the
function's entry, or into a block already reached, is a loop and
still followed). `OXWASM_TAILCUT=0` restores the old walk.

The cut block ends in the jump and the emitter treats it as the tail
call it is: `$rex` is the callee's address, the frame retires
(FTDEPTH), and the funcref table is probed - a compiled callee is
entered by `return_call_indirect`, wasm to wasm, no JS - with the
deopt to the real address as the fallback for one that is not. A
wrong guess (an "entry" that was really a case label) therefore costs
a frame of interpretation, never correctness.

On the 200 k-line m4 run (three macros: a recursive factorial via
`eval`, a string reverse via `substr`, a greeting - 3.04 s native)
under `scratchpad/runbin.mjs` with live tiering, byte-identical
output on both arms:

| | units | unit text | wall |
|---|---|---|---|
| tail cut off | 131 | 76.2 MB | 64.7 s |
| tail cut on | 133 | 65.8 MB | 63.2 s |

14% less text to assemble and compile, the same run time: the dead
code was compile-time weight, not run-time weight, as the noreturn
section predicted.

The first sweep with the cut was 120/130: perl aborted in
`malloc_consolidate`, bash, ruby, node and the python multiprocess
cases died on wild memory accesses. Bisecting bash's 109 cuts (an
allow-window over the cut sequence, `TAILCUT_LO/HI` in
`scratchpad/runbin.mjs`) landed on cut 58, `jmp free@plt` at the end
of a 70-instruction helper - a perfectly ordinary sibling call. The
helper was one the inliner had spliced into its caller, and there the
cut's terminator (spill, chain or deopt, `return`) unwinds *the
caller's* wasm frame from the middle of an inlined body. That is the
same hazard the inliner already refuses for `udec` and `jmpind`
callees ("a deopt that unwinds THIS frame; spliced in, it would unwind
the caller's"); a tail-cut jmp joined that list. With inlining off the
case passed, with the rule in place all nine pass. Two things the
bisect also settled on the way: restricting cut targets to addresses
the profile has seen *called* (the wider known-entries set holds
compiled loop heads and resolver-probed labels, and a forward jmp to a
loop's condition block must not be cut) was right but not sufficient,
and the chain-versus-deopt choice at the cut was not the fault (the
deopt-only variant crashed the same way). (`runbin.mjs` now prints the unit count and text
bytes it assembled, plus the yield counters: on this run 7 heads were
compiled on request and 21 nested yields fired, 0 top-level.) The
remaining static answer - a symbol-based noreturn list - stays open;
with both dynamic cuts in place, what a unit still swallows is the
neighbour after a noreturn call that nothing ever calls, and that is
dead text, not a fault.

### The batch re-measured with the yield on

Kernels, `bench/kernels/run.mjs`, 7 reps, the two arms one after the
other on an otherwise idle box (self-check: alu measured twice within
1-3%). Yield off is `OXWASM_LOOPYIELD=0`; on is the default now, with
the tail cut in.

| kernel | yield off | yield on |
|---|---:|---:|
| alu | 2.92x | 2.99x |
| mem | 2.47x | 2.45x |
| call | 11.47x | 11.81x |
| branch | 1.96x | 1.39x |
| subw | 5.48x | 3.43x |
| muldiv | 1.59x | 1.59x |
| scan | 3.94x | 1.57x |

The loop-shaped kernels whose hot loop sat in baseline code are the
ones that move (branch, subw, scan: 1.4-2.5x better); alu, mem and
muldiv were already in tiered code by their shape and read the same.
The call kernel reads 3% worse: that is the FTNEST store pair around
every in-unit call site, the price of the nesting rule, on the one
kernel that is nothing but calls. The call kernel itself - 11.5x, the
dispatch protocol, unchanged by anything in this round - remains the
band's ceiling and the open item.

Steady state of real binaries, the two-size subtraction of
`bench/vsnative.mjs` (3 reps; the macro file is the three-macro one
above, 200 k against 20 k lines; the text file 400 k lines of random
words, 22 MB, against a tenth of it):

| binary | work | engine | native | ratio | before |
|---|---|---:|---:|---:|---:|
| m4 | 200 k macro lines | 19.4 s | 2.61 s | **7.42x** (28%) | 8.4x |
| vim -es | `%s` + write over 400 k lines | 2.69 s | 0.57 s | **4.70x** (85%) | 5.7x |

The 22 MB text was too small for the byte-streaming tools: sha256sum
finished it in 68 ms native and the engine's two runs differed by
-7 ms (all startup), and gzip's run was 56% startup. Both re-measured
on 267 MB (the text repeated twelve times) against a tenth of it:

| binary | work | engine | native | ratio |
|---|---|---:|---:|---:|
| sha256sum | 267 MB | 0.95 s | 0.73 s | **1.29x** (78%, ±15%) |
| gzip -c | 267 MB | 20.7 s | 8.33 s | **2.48x** (18%, ±7%) |

sha256sum's hot loop is one compiled function of straight-line SSE
and rotates: 1.3x is where the alu/mem kernels say the codegen sits,
at a resolution too poor to call it closer. gzip's 2.5x is a
Huffman/LZ77 inner loop with a call per literal and a table lookup per
match: between the mem kernel and the call kernel, as its shape
predicts. vim's 4.7x and m4's 7.4x remain the call-dense band, and
their gap to gzip is the dispatch protocol priced earlier: 11.5x on
pure calls.

### The yield never fired on a conditional back edge

The kernels table above said the yield moved scan, branch and subw
and left alu and mem where they were - and alu was the kernel whose
TurboFan-forced ideal is 0.87x. A two-size subtraction under
`runbin.mjs` (60M against 600M iterations, one run each) put numbers
on it: alu 5.6 ns per iteration by default, 5.1 under
`--liftoff-only`, 1.15 under `--no-liftoff`, native 1.56. The default
run never left Liftoff, yield or no yield (`OXWASM_LOOPYIELD=0` read
the same 5.5).

The cause was in the emitter, not the mechanism. The burn-and-probe
sequence lives in `goto()`; the structured layout's `jcc` path emitted
`br_if` through the label helper directly, so a *conditional* backward
edge never burned the budget. gcc closes nearly every counted loop
with `cmp; jne head`; the loops that yielded were the ones closed by
an unconditional `jmp` - scan's `jmp .cond` shape, and the dispatch
layout, whose jcc already routed through `goto()`. Backward
conditional edges now go through `goto()` (an `if` around the burn and
branch instead of `br_if`; forward edges keep `br_if`).

Two smaller findings from the same session:

- **The counters could not see a top-level yield.** `dispatchAot`
  tested FTLOOP for zero after the frame returned, but the yield tail
  refills the word before returning, and the nested counter only
  counted heads that had missed the probe. Both were blind to the
  common case. The `$yield` tail now bumps two words itself (FTMAP+24
  top-level returns, FTMAP+28 nested deopts) and `runbin.mjs` prints
  them: mem at 60M iterations reads 14 top-level yields at the 4M
  budget and 599 at 100k, as designed.
- **Single-run two-size timings are not trustworthy for tiering
  questions.** The same mem configuration read 3.9 ns/iter in one run
  and 1.2 in another; V8 compiles the loop function's TurboFan code on
  a background thread whose job lands at a variable time (behind the
  engine's own stream of new-unit compiles), and everything before it
  lands runs in Liftoff. The 7-rep harness with ~1.5G iterations per
  rep is the instrument; `--wasm-tiering-budget=1000` and
  `--no-liftoff` bound what the code *can* do. Browsers take no V8
  flags, so the engine's own knob is the yield period
  (`OXWASM_LOOPYIELD_N` overrides the 4M default for A/B; 20k-iteration
  yields cost nothing measurable on alu).

Kernels harness, 7 reps, N auto-calibrated (alu at 6.5G iterations):

| kernel | before | after |
|---|---:|---:|
| alu | 2.99x | **1.40x** |
| mem | 2.45x | **1.31x** |
| call | 11.81x | 9.27x |
| branch | 1.39x | 1.37x |
| subw | 3.43x | 3.50x |
| muldiv | 1.59x | **1.00x** |
| scan | 1.57x | 1.60x |

The real-binary batch on the same build is unchanged within its
noise (m4 7.74x, vim 4.86x, gzip 2.67x on the small input): their hot
paths are call-dense or were tiered already, and none of them runs a
single loop long enough for the yield to matter.

alu and mem are within 1.4x of native and muldiv at parity - the
straight-line kernels whose top-tier ideal is parity; what is left of
their gap is the Liftoff phase before the background TurboFan job
lands, amortised over the rep, plus the burn on every back edge. subw
did not move: its loop is `jmp`-closed and was yielding all along, so
its 3.5x is codegen (the sub-word merges), not tier occupancy - the
next straight-line item. The call kernel's 9.3x is the same protocol
as before at a different auto-calibrated N.

**A per-frame local for the budget: worse, reverted.** subw's loop
body is fifteen wasm ops and the burn adds three memory operations
per iteration (load, store, reload of FTLOOP), so the obvious next
step was a per-frame local: initialised to N at entry, decremented at
back edges, refilled on a loophot miss, no memory at all. Back to
back, 5 reps each, same session:

| kernel | memory word | local |
|---|---:|---:|
| alu | 1.40x | 1.80x |
| subw | 3.47x | 4.13x |
| scan | 1.59x | 1.93x |

Worse across the board, by a similar margin, and reverted. The
reading that fits is that V8's dynamic tiering budget is an estimate
of *code bytes executed*: a shorter loop body decrements it more
slowly, the TurboFan job is requested later, and the Liftoff phase -
which these ratios are still made of - grows. The three memory ops are
cheap next to that. The memory word stays; what this measures is how
much of the remaining straight-line gap is Liftoff occupancy, which
the next probe (the harness under `--no-liftoff`) bounds directly.

### The burn is the straight-line gap

The `--no-liftoff` harness settled the tier question the opposite way
from what the local-budget result suggested: forced TurboFan reads
alu 1.41x, mem 1.30x, subw 3.48x, scan 1.58x - the *same* numbers as
the default build. These loops already run in TurboFan; what is left
is codegen. And the codegen difference to the old parity table (alu
0.87x, subw 1.07x, measured before the yield existed) is the yield
emission itself. Three arms under `--no-liftoff`, 3 reps:

| kernel | yield off | memory word | local counter |
|---|---:|---:|---:|
| alu | **1.01x** | 1.41x | 1.77x |
| subw | **1.93x** | 3.48x | 4.24x |
| scan | **1.23x** | 1.58x | 1.95x |

The burn - load, decrement, store, reload, test, and the cold probe
with its `call $ftr` and the `br $yield` exit sitting inside the loop
body - costs 40% on alu, 80% on subw, 28% on scan under TurboFan. The
local-counter variant is worse than the memory word, which reads as
register pressure: the guest's sixteen registers already live in i64
locals, and a loop-carried counter is one more value the allocator
has to keep in a machine register. (subw's 1.93x with the yield off is
its own codegen item: the 32-bit ops each wrap and extend, and the
byte read masks.)

So the loop yield buys tier occupancy at 30-80% of the loop, which
is still a net win against Liftoff's 3-5x but is the next thing to
make cheaper: burn less (every k-th edge, or one burn per loop rather
than per back edge), keep the probe and exit out of the loop body, or
count in something the allocator does not have to carry.

Two more arms split the burn itself (forced TurboFan, 3 reps): the
read-modify-write alone, with no probe and no exit in the loop, reads
alu 1.39x, subw 2.85x, scan 1.71x - on alu it *is* the whole cost; a
single-load form of the same burn (`local.tee` of the decremented
value) was no better and noisier. A per-iteration store-and-reload of
one word costs two to three cycles on loops native runs in two, and
no arrangement of the same per-iteration operations recovers it. The
count has to happen less often: unroll single-block self-loops k
times with one burn per k iterations, which divides the cost by k on
exactly the loops that pay it.

### Unrolling the loops that pay the burn

The burn cannot be made cheaper per iteration; it can be made rarer.
The emitter now unrolls the two loop shapes gcc produces for counted
and while loops, when the blocks are short (≤24 instructions) and
contain no call, syscall, indirect jump or undecodable byte:

- a **single-block self-loop** (`body; cmp; jcc head`): the block is
  emitted k times inside its `loop`, wrapped in a `(block $sx_i)`;
  copies 0..k-2 test the loop's *exit* condition and `br $sx_i` out
  (or branch to the exit block, or deopt, as the original edge did),
  falling through into the next copy on the loop-back; the last copy
  keeps the real terminator, and with it the one burn per k
  iterations;
- the **two-block while shape** (`head: cmp; jcc exit` /
  `body: ...; jmp head`, the body reachable only from the head): k
  copies of (head, body), every head copy exiting through `$sx_i`,
  body copies 0..k-2 falling into the next head copy, the last body
  copy keeping its `jmp` terminator and burn. The body block's own
  slot is emitted empty.

A copy is byte-for-byte the block's own code, so the lazy-flag state
entering copy c+1 is the state the analyzer already meets at the head
from the back edge, and every exit takes the edge the original block
took. `OXWASM_UNROLL` sets k (1 disables); default 8.

Kernels harness, 5 reps, default tiers:

| kernel | before | k=4 | k=8 |
|---|---:|---:|---:|
| alu | 1.40x | 1.33x | **1.36x** |
| mem | 1.31x | 0.66x | **0.62x** |
| subw | 3.50x | 1.63x | **1.36x** |
| scan | 1.60x | 1.56x | 1.62x |
| branch | 1.37x | - | 1.37x |
| muldiv | 1.00x | - | 1.05x |

mem now runs *faster than gcc -O2* (the native loop is not unrolled;
the engine's is), subw drops from 3.5x to 1.36x, alu moves only from
1.40x to 1.36x - its yield-off ideal is 1.01x, so something in the
unrolled body still costs it, most likely register pressure across a
13-instruction block copied eight times (k=4 reads the same, so it is
not the unroll factor alone). scan and branch are multi-block loops
with several back edges and are not unrolled yet; that is the general
case (duplicate the loop's whole block set k times with the internal
labels renamed) and the next step for the burn.

One detour on the way: the first build "hung" on alu. It was not a
hang - a counter line referenced a `stats` object that lives in the
narrowing pass's scope, every unit compile threw at its first
unrolled block, the try/catch around tier-up swallowed it, and the
run was the interpreter alone. The unit emitter throwing is
indistinguishable from a hang from outside; the debug prints that
found it are gone again.

### Unrolling at the CFG level

The emit-time unroll knew two shapes. The general one is simpler to
state at the CFG: after the analyzer's blocks are laid out in RPO and
their terminators resolved to indices, a natural loop [h, e) that is
short and plain (≤8 blocks, ≤64 instructions, no call, syscall,
indirect jump, undecodable byte or inlined splice; no nested loop, no
other loop overlapping it) is duplicated k-1 times right after
itself. Copy c's internal edges stay inside copy c; its back edge to h
goes *forward* to copy c+1's head; only the last copy's back edge
returns to h. That leaves one backward edge, so `structure()` sees one
loop and `goto()` emits one burn per k iterations, and every exit
keeps its (shifted) target and stays a forward edge. The copies are
the same block objects - same instructions, same guest address - so
deopt targets, the probe's head address and jump tables need nothing;
the flag and liveness analyses run afterwards on the widened CFG and
see ordinary blocks. Jump-table functions are excluded (the dispatch
layout keeps address-indexed rows), and higher loops are processed
first so an insertion never shifts a lower range.

The first form of the pass excluded nested and overlapping loops and
missed scan: its tokenizer loop has two back-edge targets one block
apart (`add %rsi` / `add %rax`, the continue paths of different
cases), which `structure()` sees as two nested loops sharing most of
their blocks. Loops that share blocks now form one cluster [H, E)
and unroll as a whole: inside a copy every back edge - to any header
of the cluster - goes forward to the next copy's image of that
header, so a copy has no backward edge at all; the last copy's back
edges return to the originals.

Kernels harness, 5 reps, default tiers:

| kernel | emit-time unroll | CFG-level |
|---|---:|---:|
| alu | 1.36x | 1.38x |
| mem | 0.62x | 0.61x |
| subw | 1.36x | 1.40x |
| scan | 1.62x | **1.18x** |
| branch | 1.37x | 1.41x |
| muldiv | 1.05x | 1.04x |
| call | 9.0x | 9.3x |

scan drops to 1.18x (its yield-off ideal under TurboFan was 1.23x - the
unroll is at the ideal); branch reads 1.41x against its 1.07x ideal,
so its remaining cost is not the burn (an `imul`-fed unpredictable
branch pair; the lazy-flag materialisation per `test` is the suspect).
Every straight-line kernel is now within 1.4x of native and two are
at or past parity.

The real-binary batch on this build (two-size subtraction, 3 reps):
m4 **7.29x** (30% startup), gzip 2.53x on 267 MB (18%), vim 4.59x (86%,
an upper bound), sha256sum 2.23x at 69% startup - the last two are
startup-dominated and only bound the number; sha256sum is re-measured
below on 800 MB. m4 and vim do not move with the loop work: their
time is calls, not loops.

sha256sum on 800 MB (40% startup, ±11%): **1.75x**. Its compression
function is one basic block of several hundred instructions, so
neither the unroll nor the burn touches it; 1.75x on straight SSE
and rotate code is a codegen number of its own.

A named CPU profile of m4 on the 200 k-line input (`--cpu-prof` over
`realab-run.mjs`, 48.7 s sampled including compile): `next_token`
5.3 s, `peek_input` 2.6 s, five m4 helpers at 1.0-1.4 s each, the
unit emitter 1.5 s, GC 1.5 s - and 16.7 s in the harness's own file
provisioning (`read`/`add`), which is startup the two-size subtraction
removes. `next_token` alone runs twice native m4's whole run: it is a
jump-table function (the switch over the character class), so it
takes the dispatch layout, whose every non-fallthrough edge goes
through the `br_table` dispatcher, and it is excluded from the loop
unroll for the same reason. That is the next lever for the call-dense
band: a switch inside a loop should not cost a dispatcher round-trip
per character.

### Jump tables in the structured layout

A resolved jump table forced the dispatch layout, because its
computed goto needed `$pc` and the `$L_disp` br_table loop - and in
that layout *every* non-fallthrough edge of the function pays the
dispatcher round-trip, not only the switch. `next_token` is exactly
this shape (a switch over the character class inside the input loop),
and it was the top of m4's profile.

The structured layout now takes jump-table functions. The table's
targets are all in `succs`, so `structure()` has already given each
one a scope label that is in view at the jump site; the computed
address resolves to its RPO index through the same `$jtr` function,
and a `br_table` over a vector mapping index → label does the branch
(`$blk_r` for a forward target, `$loop_r` for a back edge, a
`$jt_next_i` label for the block that follows by fall-through and so
has no scope of its own). Anything else - an unknown address, a block
that is not a table target, `$pc` = -1 - takes the default and deopts
at the computed address, as before. Functions whose fan-in
`structure()` cannot nest still fall back to dispatch.

m4 on the 200 k-line input under live tiering (compile included):
63.2 s → **48.2 s**, output identical to native. Steady state by the
two-size subtraction: **7.38x** - unchanged, and the per-function
layout trace (`LAYOUTOF=` in `runbin.mjs`) says why: no m4 function
reaches the new path, because `next_token` has one jump table on a
cold path and its layout is decided by something else.

### Why m4's hot functions are in the dispatch layout

`next_token` (181 blocks), and 216 of m4's 683 compiled functions,
fall back to dispatch with "block/loop overlap". Two causes, one
fixed:

- **Interleaved layout.** Plain reverse postorder can place a block
  that is not part of a loop between the loop's blocks (an exit path
  laid out before a later body block); a forward branch into it then
  looks like a branch into the loop's index range. The layout is now
  loop-aware: for every back edge the natural loop's members are
  compacted to sit contiguously from the header and the interleaved
  non-members move after the loop's last member (a non-member inside
  the range cannot branch to a member or the header, so its edges stay
  forward). `OXWASM_LOOPLAYOUT=0` restores plain RPO. On m4 this
  compacts 1,811 loops and moves 62,117 blocks, narrows loop ranges
  (one from [44,352) to [44,89)), and takes 19 functions out of
  dispatch: 216 → 197.
- **Second entries.** What remains is real: `block[54,81) vs
  loop[57,102)` in `next_token` is a forward branch from before the
  loop's header into a member of the loop - a loop with two entries,
  which structured control flow cannot express without duplicating
  the loop rotated at the second entry (node splitting). gcc's
  cross-jumping and shared tails produce these routinely in optimised
  code. Whether that duplication is worth building depends on what
  the dispatch layout costs, measured next with `OXWASM_FORCEDISP=1`
  on the kernels.

**The dispatch layout costs nothing measurable.** Kernels with every
function forced into dispatch (`OXWASM_FORCEDISP=1`, 3 reps): alu
1.33x, scan 1.25x, branch 1.42x, subw 1.37x, against 1.38x, 1.18x,
1.41x, 1.40x structured. The self-loop `loop` wrap and the unroll work
in both layouts, and the `br_table` round-trip on the remaining edges
is in the noise. So node splitting for two-entry loops is not worth
building, and `next_token`'s 4x per character is not its layout. The
loop-aware layout and the structured jump tables stay: correct, and
19 fewer functions in dispatch on m4.

**514 million calls.** A function-entry counter (`OXWASM_COUNTCALLS=1`,
a word bumped in every prologue, read by `runbin.mjs`) puts the
200 k-line m4 run at 514,319,979 function entries - 26 million per
second of its ~20 s steady state, 39 ns per call including the
callee's work, against native's 5.3 ns for the same calls. At the
idealcall prices (a narrowed in-unit call ≈ 6.6 ns against a bare
wasm call's 2.2 and native's ~1.5) the call protocol alone is 2-3 s
of the 20; the rest is the bodies of very small functions, whose
prologues, epilogues and register traffic are most of what they do.

**The narrowing pass is off.** The callee-protocol narrowing (both
halves: the caller's spill before a call and the callee's reload at
entry cut to what is live) was measured a null on the call kernel and
left behind `OXWASM_NARROW=1`. The call kernel's leaf touches two
registers; m4's callees touch more, and on m4 the pass reports what it
would remove: 163,882 spill stores kept of 520,463 (68% skipped),
139,671 reload loads kept of 480,946 (71% skipped), over 27,670 call
sites and 25,218 return sites - static counts, but the shape holds
dynamically for 514 million calls. Turned on, though, m4 diverges and
dies on a wild address: the pass predates the loop yield, the unroll,
the tail cut and the loop-aware layout, and its liveness does not
model one of them. Bisected next.

**Found and fixed.** The bisect took one step: with the loop yield off
the narrowed m4 is exact; with it on it dies. The pass tracks *dirty*
registers (written since the last spill or reload site) and spills
only those at a call or return, which is sound because a clean
register's memory copy is current. The shared `$yield` tail is the one
spill site the pass never sees: it stores every register the function
touches - and with the narrowed prologue, a register that is not live
at entry is never reloaded, so until the path writes it its local is
the zero wasm gives a fresh local, and the tail stored that zero over
the caller's value. A function that can yield now reloads everything
it touches at entry; the caller-side spill, the exit spill and the
post-call reload stay narrowed. m4 is exact on both inputs with the
pass on.

With the pass on (default now; `OXWASM_NARROW=0` for A/B): the call
kernel 9.3x → **6.54x**, m4 steady state 7.38x → **6.95x** (two-size,
3 reps), alu and scan unchanged (1.39x, 1.17x). The kernel's leaf
touches two registers, which is why it read as a null in isolation;
at 514 million real calls the 68% of stores and 71% of loads it
removes are worth 30% on pure calls and 6% on m4.

### A real call profile, and why m4's hot callees are not inlined

`aotCalls` is a threshold detector: it counts an interpreted call target
up to the tier-up threshold and then never again (compiled-to-compiled
calls run inside wasm). It cannot rank callees. `OXWASM_FNPROF=1`
adds one memory increment to every function prologue (a slot hashed
from the function address into the dead space above `FTMAP`; runbin
reads the slots back per compiled entry and flags collisions). On the
m4 s10 input it counts 25.8M entries into 244 functions; the top four
are 18.7%, 10.5%, 7.9% and 6.9% of all entries, the top twelve are 71%.

`OXWASM_INLINE_ONLY=<those>` then asks the inliner why each was
refused, and the answer is not a budget tweak:

- the hottest (`409e80`, 18.7%) and three more are **not-in-unit**:
  they tiered up before their callers, so closure pruning keeps them
  out of every later unit and the inliner never sees them;
- the second (`40fe70`, 10.5%) is **758 instructions** against a
  160-instruction cap;
- `417160` (1.4%, called from 30 callers) has a **deopt instruction**
  (an indirect jump or a tail-cut sibling call) that cannot be spliced.

So the inliner's population on m4 is the wrong one by construction:
the callees worth inlining are exactly the ones hot enough to have
tiered up on their own. The obvious fix is a second compile of a hot
caller with its hot small callees un-pruned, driven by this profile (a
re-tier). `OXWASM_UNPRUNE=hex,hex` measures its upper bound by
exempting those callees from pruning in every unit, and the bound is
nil: 143 → 154 functions inlined, 870 → 894 callees, m4 s10 unchanged
(24.8/25.6s vs 26.0/29.4s). Asked again with the callees in the
closure, the inliner refuses the hottest (`409e80`) and `4164c0` as
**deopt-insn**: each ends in a tail-cut jmp (a sibling call to
another known entry), which the splice cannot carry because the copy's
`ret` has been rewritten into a branch to the return point and a jmp
out has no such point. The un-prune alone buys nothing; what m4's
hottest callee needs is a splice that turns a tail-cut jmp inside a
copy into a call to the sibling followed by the copy's return - the
caller's `call` still pushed the return address, so the sibling's
`ret` lands where a normal call's would. That splice is in (a callee's
tail-cut jmp becomes the call protocol to the sibling and a branch to
the inlined site's continuation; m4 and bison exact), and it changes
nothing on m4: with the hot callees un-pruned as well, `409e80` is
still refused, now as **deopt-insn** for a different instruction - a
`jmp *%rax` switch at the end of the function (peek_input's character
class dispatch) that jump-table discovery does not resolve. It runs
rarely (135 deopts in the whole run) but the inliner refuses any
instruction that can deopt, because a deopt inside a copy unwinds the
caller's frame. Un-prune + splice together: 143 → 155 functions
inlined, m4 s10 unchanged. The inliner is exhausted on m4; what is
left there is the per-call cost itself, profiled next.

Found while gating this batch: every structured-layout function with
a jump table called a `$jtr_` resolver that only the dispatch epilogue
emitted, so the unit failed to assemble and fell back to the
interpreter - 18k such errors in one breadth sweep, all in python3,
node and php (computed-goto interpreters). Both epilogues emit it now.

### next_token per entry, from the block profile

`OXWASM_BLKPROF=40fe70` counts entries per block of one function (the
upper half of the FNPROF dead space; runbin prints slots, resolved
against the function's address range). On m4 s10 `next_token` is
entered 2.73M times and thirteen of its blocks run exactly once per
entry: it is called once per token, runs a straight-line path of
~80 instructions with two calls (one in-unit direct, one to the
pruned `peek_input` through the `$ftr` chain) and returns; the
per-character work is in `peek_input`, not here. Its 93 ns per entry
(254 ms of wasm self time over 2.73M entries in the s10 profile) is
spread thin: the prologue reloads all 16 registers because the
function can yield (the precise entry set for yielding functions is
still open), the reload after the chained call is the full 16 because
in the dispatch layout every register is live at the dispatch head,
thirteen `br_table` round-trips, and two call protocols. No single
item is more than ~10% of the function. The two reload sets are the
concrete levers left in it, worth perhaps 10% of `next_token`.

Also from this batch's gating, the resolver fix priced against the
pre-batch engine (cold breadth cases, compile included): python3
270.8 s → 49.1 s, php 105.5 s → 25.8 s. Those are the structured-layout
jump tables working on computed-goto interpreters; the earlier
"733 s" and "72 s" were the broken intermediate.

### The batch, priced on m4 steady state

`bench/vsnative.mjs`, 200 k against 20 k lines of the regenerated
input (the earlier 200 k file was gone; this one is the same three
macros with `sq(i%100) fact(i%10) rep(i%7)`, native steady state
1.9 s where the earlier file's was 3.0 s, so ratios are not comparable
across the two inputs), 3 reps, the box otherwise idle:

| arm | steady state |
|---|---|
| pre-batch engine (3552ac4) | 10.03x |
| this head | **8.93x** |
| this head, `OXWASM_NARROW=0` | 10.37x |
| this head, `OXWASM_INLINE=0` | 8.98x |

The batch is worth 11% on m4, all of it the narrowing (14% on its
own); the inliner, tail splice included, is within noise on m4. The
cold sweep (124 cases across four runs, the last two alone on the box
after two OOM kills) is green on this head with zero assembler errors.

### branch's residual, revisited on this head

`WATDUMP=dir` on the kernels runner keeps every unit's text. The
branch loop's unit (rooted at the loop head, 8 copies in one
`loop`) is near the ideal shape: per iteration one `i64.mul`, one
`i64.add`, the `test` as a single `i64.and` (with a redundant 32-bit
mask), `br_if` on `i64.eqz`, and the loop counter compare as a
subtract; the `$fa`/`$fb` sets are dead and TurboFan drops them. There
is no lazy-flag materialisation left to remove. Measured on this head
(5 reps, N calibrated to 1013M): branch **1.17x** against the 1.41x
last recorded and its 1.07x forced-TurboFan ideal, self-check 1.20x
and 1.18x; the harness resolves ~2%. The earlier 1.41x was measured
before the loop-aware layout and the narrowing default; the residual
now is within a mispredict-dominated loop's noise of its ideal.

### The ABI-trusting reload: 16% on pure calls, opt-in

After a call the reload can skip rbx, rbp and r12-r15: the guest's
compiler relied on them being callee-saved at every call site it
emitted, so their memory copies after the callee returns equal what
this frame spilled, which the locals still hold. rsp stays reloaded
(the local holds the post-push value) and syscalls keep the full
reload. In the backward pass those registers stay live through the
call instead of being defined by the reload, so a callee-saved value
live after the call is reloaded at entry. Measured on this head: call
kernel 4.94x → **4.17x**, m4 steady state 8.93x → **8.65x**; breadth
m4/bison/python3/sh/perl/gzip and 14 more byte-identical.

It is `OXWASM_ABIRELOAD=1`, not the default: the suite's call-mem test
(hand-written asm whose callee accumulates into rbx and whose caller
reads it) exits 8 instead of 100 with it on. "Any unmodified program"
includes code that passes values back in callee-saved registers, so
the default stays exact, and the number stands as the price of that.

Also from this pass: the kernel table on this head reads alu 1.82x,
mem 1.15x, subw 1.01x, muldiv 1.01x, scan 1.15x, branch 1.17x, call
4.71x. alu and mem are not a regression of the batch: the pre-batch
engine reads 1.74x and 1.11x at the same N today against this head's
1.79x and 1.10x, so the 1.38x/0.61x last recorded were a different
day's calibration (N, box), not a different engine. Trend claims need
both arms measured in one sitting.

### Closure pruning was the call kernel's whole gap; tiny callees stay in

The call kernel's unit had no direct call in it: its 4-instruction
leaf tiers up before the loop, so every later unit is pruned of it and
reaches it through the `$ftr` chain (hash probe, `call_indirect`,
budget save/restore) at all 30 sites. Kept in the unit
(`OXWASM_UNPRUNE=4018b5`) the direct call is inlined by V8 and the
kernel reads **0.56x** against 4.42x chained - the whole gap, and past
native.

So pruning now has one exception: a callee that analyses to at most
`OXWASM_UNPRUNE_TINY` (16) instructions with no undecodable byte or
indirect jump stays in every unit that calls it, already compiled or
not; the verdict is memoised per engine. The earlier un-prune
experiment that doubled gzip's unit and quadrupled its tier-up used
the inliner's 160-instruction budget as "small"; at 16 a copy is a few
lines per site. On this head: call kernel 4.42x → **0.55x**, suite
exact, 21 breadth cases byte-identical, gzip's unit count unchanged
(310 against 312 with it off), m4 steady state 8.93x → 8.69x (its hot
callees are hundreds of instructions; this is not m4's lever).

The gate on the tiny-callee head: the cold sweep is green, 128 cases
with zero failures and zero assembler errors, run in two pieces after
the single-process runner was OOM-killed by the memory cgroup at
7.5 GB resident on case 119 (it accumulates across cases; sweeps run
in chunks now). Two-size steady state with and without it, 3 reps:

| binary | work | with (16) | `OXWASM_UNPRUNE_TINY=0` |
|---|---|---:|---:|
| perl | 30M-iteration loop, 1.2 s native | 6.94x | 7.02x |
| vim -es | `%s` over 400 k lines | **3.72x** | 4.45x |

vim moves 16%; perl does not - its hot callees (the pp_ ops) are far
past 16 instructions and stay chained, which is the next question: what
a larger cap costs in unit size and tier-up against what it buys on
perl and m4.

**A larger cap does not pay.** `OXWASM_UNPRUNE_TINY` at 16, 64 and
200 on the same box, same sitting (3 reps; unit text from one runbin
pass of the 30M-iteration perl loop):

| cap | perl units / text | perl | m4 |
|---|---|---:|---:|
| 16 | 243 / 126 MB | 7.31x | 8.96x |
| 64 | 246 / 133 MB | 7.31x | 9.13x |
| 200 | 252 / 211 MB | 7.45x | 8.30x |

perl is flat because its hot calls are INDIRECT (`call *%rax` through
`PL_ppaddr`, one per op): un-pruning only turns direct `call`
instructions into direct wasm calls; a `callind` always takes the
inline-cache probe and `call_indirect`. m4's 8.30x at 200 costs 67%
more unit text for a reading inside its 8.3-9.1x day-to-day spread.
The cap stays at 16; perl's lever is the indirect-call protocol and
the callee prologue, not the closure.

### perl's tax is the indirect-call protocol: a kernel for it

perl's 30M-iteration loop makes 12 function entries per iteration in
ten pp_ functions (FNPROF), every one reached by the runloop's
`call *%rax`, and its 7x is ~20 ns per entry over native. A new kernel
prices exactly that shape: `callind` calls one of four 4-instruction
leaves through a volatile pointer table, two calls per iteration, the
site megamorphic. Native 6.9 ns per call; the engine **3.06-3.19x**
(~14 ns over native per call) where the direct-call kernel is 0.57x on
the same day. The protocol's parts, A/B'd on it (3 reps, N=60M):

| arm | callind |
|---|---:|
| default | 3.19x |
| `OXWASM_NOXMMCALL=1` (drop the xmm half) | 3.13x |
| `OXWASM_ABIRELOAD=1` (skip callee-saved reloads) | 2.85x |
| `OXWASM_NARROW=0` (full spills and reloads) | 3.45x |
| both levers | 2.88x |

Register traffic is a fifth of it at most (narrowing 8%, the ABI
reload another 10%); the rest is the inline-cache probe,
`call_indirect`, the budget/fuel/nest accounting and the callee's own
entry and exit - priced next from the unit text.

**The accounting is free and the floor is 1.47x.** `OXWASM_NOACCT=1`
(a pricing probe: no nest counter, no chain fuel at any call site)
reads callind 3.09x against 3.08x - the budget/fuel/nest words cost
nothing measurable, as the idealcall `budget` arm said of the depth
check. `bench/kernels/idealcallind.mjs` is the same loop as
hand-written wasm, state in locals, four leaves reached only through
`call_indirect` on a 4-entry table: **1.47x** native (1213 ms against
825 ms for 120M calls, same result value). So V8's indirect call is
the floor at 1.47x and the engine's protocol around it is the other
half: at 3.08x it adds ~11 ns per call over that floor, spread across
the inline-cache probe (a dependent mul/shift/load/compare chain
before the call), the return-address push and pop, the depth
save/check/restore, and the callee's two entry loads and three exit
stores. Narrowing and the ABI reload are the only pieces priced above
5% each; there is no single item left in it.

**perl's ten hot pp_ functions, as compiled** (from a unit dump of the
3M-iteration loop; each is 8-17% of the run's 36M entries):

| fn | unit lines | entry reloads | yield | layout | call sites |
|---|---:|---:|---|---|---:|
| 532550 | 92 | 4 | no | structured | 1 |
| 532fc0 | 179 | 7 | no | structured | 3 |
| 532640 | 146 | 4 | no | structured | 2 |
| 533390 | 188 | 10 | no | structured | 3 |
| 53ef10 | 2267 | 16 | yes | dispatch | 29 |
| 53ef59 | 2176 | 16 | yes | dispatch | 27 |
| 53f0a0 | 9280 | all | yes | dispatch | 152 |
| 567df0 | 1289 | 18 | no | structured | 15 |
| 569780 | 1085 | 20 | no | structured | 13 |
| 534360 | 1100 | 15 | no | structured | 11 |

Four are small leaves with 4-10 entry reloads; six are 1-9k-line
bodies entered once per iteration, three of them in the dispatch
layout with the full 16-register entry reload because they can yield.
That is perl's 7x against the kernel's 3.1x: the same indirect-call
protocol per entry (the kernel's 14 ns), plus a big function's own
per-entry cost - its prologue reload, its dispatch loop, and a body
that runs a few dozen instructions of a large CFG and returns. The
precise entry-reload set for yielding functions is worth 1-2% here,
same as on m4. There is no single lever left in the call-dense band;
what remains is the sum of a protocol at 2x V8's own floor and the
per-entry cost of large interpreter functions.

### Breadth batch 5: Rust and Go binaries

Sixteen new binaries probed. curl, gpg, zip, as, strip, ar and strace
passed as they were; ffmpeg and java only need their library trees
provisioned. The engine gaps, each landed with a case or a suite test:

- **Rust std stats directory fds** with `newfstatat(fd, "",
  AT_EMPTY_PATH)` and probes NULL paths; the file-only branch threw
  on a directory handle and the NULL read faulted at 0. The form now
  takes fstat's per-handle logic and a NULL path without the flag is
  EFAULT. ripgrep runs (`rg`); the rustup proxy on PATH runs to its
  own "no default toolchain" message.
- **Go's runtime** reserves address space in bulk: a dozen 64 MB arena
  hints (each returned elsewhere, unmapped, retried) and a 512 MB page
  summary. The mmap arena was bump-only and never reclaimed munmapped
  ranges, so a 3 GB slab ran dry on reservations Go had released;
  munmap now returns arena ranges to a first-fit hole list.
- Go's page allocator uses **`rcr`**; the decoder threw. rcl/rcr run in
  the interpreter (count masked as the CPU does, 8/16-bit mod 9/17, OF
  at count 1) and deopt from units; `rcrtest.mjs` (8 sizes × 67 counts
  × 2 carry states, CF always, OF at count 1) is bit-exact in both
  tiers.
- Go re-execs itself by `/proc/self/exe`; readlinkat answered the
  literal '/prog' and readlink argv0. Both answer the absolute argv0
  now, '/prog' for a relative one, and '/prog' resolves to the image
  (busybox re-execs itself the same way and its shell test aborted on a
  relative name).
- **A translator bug that only Go tripped.** `go version` ran under
  the interpreter and panicked translated: "invalid Getenv GOOS", a
  `strings.Contains` over a constant table returning false. Unit-number
  bisects converged on nothing, and so did a function-veto bisect: the
  culprit was reached inside other units' closures. An allow-list
  bisect (`FNALLOW`, compile only these functions, as roots or closure
  members, tiny exception included) over the 612 functions of a
  40-line reproducer named `runtime.memequal`. Its `memeqbody` ends in
  `sub; shl %cl; sete`, with a `je` from an earlier `cmp` into the sete
  block. The cross-block flag dataflow gave a block ending in an
  unmodeled writer (the variable-count shift) an EMPTY out-set, so the
  sete block saw only the cmp's definition and compiled against it;
  on the shl path it read the wrong flags and memequal answered false
  for every 1-7 byte string. A clobbered block now propagates a kill
  sentinel and a consumer it reaches poisons the function into the
  interpreter, as the design intended. `go version` prints its version
  translated; two cases (`gostrings`, a Go binary built at sweep start,
  and `go-version`) guard it.

yq and valgrind, the two "silent" probes, turned out not to be
binaries at all on this box: yq is a Python entry-point script and
valgrind a POSIX shell wrapper, and the probe's "no output" was runbin
refusing a non-ELF. The sweep on this head is green in four chunks
(129 cases, zero failures).

### ffmpeg transcodes, byte-identical

With its pulseaudio module directory provisioned (`TREE=`; the only
library runbin's flat /lib scan missed) `ffmpeg -version` prints its
banner, and a synthetic transcode - `testsrc` for one second at
64x64, hashed by the md5 muxer - produces **the same MD5 as native**
(4080e9a80cdd0249b283cfa5c4261025), exit 0, its worker threads run
and joined. The one instruction it needed was `emms` (0F 77): ffmpeg's
`av_emms` after every MMX/SSE DSP call; the decoder threw on it. It
empties the x87 stack in the interpreter (MMX aliases it) and escapes
from units. The `ffmpeg` breadth case runs a 0.3-second version.

### java: three gaps closed, one open

HotSpot (OpenJDK 21, `-Xint -version`, the whole JDK tree provisioned)
walked through three engine gaps in order, each now closed: it reads
the legacy **vsyscall page** at startup (0xffffffffff600000; now an
interpreter-only region with the kernel's three `mov eax, nr; syscall;
ret` stubs, plus `getcpu`); it probes CPUID presence by toggling the
ID bit through **pushf/popf** (now in the interpreter with the
arithmetic flags, DF and sticky AC/ID bits; escaped from units); and
its heap ergonomics read the engine's modest `sysinfo`/meminfo and
refused ("Too small maximum heap") until given `-Xmx256m`. With that
it runs 430k interpreted and 8.8k translated slices into VM
initialisation on its second thread and dies writing through a NULL
structure pointer (address 0x80) in libjvm, before it has installed
its SIGSEGV handler - so this is a wrong answer from something
earlier, not the missing fault delivery that HotSpot will need next
(safepoint polls, implicit null checks and stack banging all run on
SIGSEGV). Open.

**java, translated: an unlocated tiering interaction.** With the timed
futex fix `java -Xint -version` runs interpreter-only. Translated it
dies at a NULL class mirror in VM init, deterministically per
configuration, and the culprit moves: with loop-head roots off (no
back-edge tier-up) it passes; with the loop threshold at 100k it
passes; at 30k it fails and vetoing one unit, glibc's
`pthread_mutex_trylock` (rooted through a backward `jmp` to its entry),
makes it pass; at the default threshold that veto no longer helps and
another unit takes its place. trylock's translation passes two C
differentials (four mutex kinds, contention, a second thread), the
engine's shadow mode finds only dead-flag differences at returns in
libc, and the JVM's debug log is identical up to the fault whether or
not trylock is vetoed. So this is not one miscompiled function: some
mechanism around loop-rooted units misbehaves in HotSpot's threaded
init and which unit exposes it depends on tiering order. Levers that
do NOT change it: loop yield, unroll, loop layout, inliner, tiny
un-prune, tail cuts, narrowing, TLAB, compressed oops. Parked with
the tools it produced: `LOOPUNITS`, `LOOPTHRESH`, `FNALLOW`/`FNVETO`,
`UNITVETOADDR`, `SHADOWLIB`, `STOPFILE`.

### PIC jump tables, and java translated

The table recogniser knew only absolute tables (`jmp *table(,%idx,8)`
and a `mov` from one). Every -fPIC/PIE binary - all of Ubuntu's, and
glibc - emits the relative form instead:

    lea    table(%rip), %rdx
    movslq (%rdx,%rax,4), %rax
    add    %rdx, %rax
    jmp    *%rax

so every such `switch` fell to the chain/deopt form at every case.
The recogniser now follows that chain of definitions and reads int32
offsets relative to the table. One rule made it safe: the entry count
comes from the bounds check the compiler always emits just before the
load (`cmp $N, %idx; ja default`), and without that guard no table is
taken - the first cut read entries until one fell outside a ±1 MB
window, and int32 garbage past a table's end is small enough to land
inside it; those phantom targets became block leaders that split real
instructions and perl and awk faulted.

With it, glibc's mutex kind switch is a `br_table` and **`java -Xint
-version` passes translated** (51 tables structured, 3,927 functions
compiled, banner printed, exit 0): the loop-rooted interaction parked
above ran through the chain form of exactly these switches. Suite
exact; perl, perl-fork, awk, awk-prog, gzip, m4, python3, jq, bc, git
byte-identical.

**Java bytecode runs translated.** A hello-world class - a 200k-iteration
long loop, StringBuilder, `Integer.toHexString`, `Math.sqrt` - prints
exactly what native prints (`hello from java 1199992 0,1,2,3,4, cafe
1.4142135623730951`), exit 0, ten JVM threads, 325 s cold. That is
HotSpot's template interpreter - machine code the JVM generates at
startup into its code cache - executing bytecode under the engine's
own translation, on top of the VM init that took the vsyscall page,
pushf/popf, timed futex waits, hole-carving fixed mappings and PIC
jump tables to reach. The sweep on this head is green in four chunks
(164 case runs, zero failures); `java-version` and `java-hello` are
cases.
For steady state the structured tables are not a lever on m4 (8.55x,
inside its 8.3-9.1x spread); they are a correctness and generality
change first.

### The cold-run tax was the fork, not the assembler

A CPU profile of the cold `java -version` run (230 s) put 80% in
`spawnSync`. wat2wasm itself is quick - 40 ms per MB of text, and a
spawn from a small process costs 4 ms - but a spawn from a process
holding a 3 GB guest costs 133 ms, because fork copies the parent's
page tables, and 960 units each paid it. `tools/assemble.mjs` is a
pre-forked broker: a tiny shell started before the engine grows,
handed unit paths over one FIFO and answering an exit status over
another, synchronously (a blocking read on the FIFO), with a direct
spawn as the fallback. runbin and the breadth harness use it.
**`java -version` cold: 230 s → 50 s**; a cold breadth chunk of 16
cases (cache cleared) is green and quicker throughout (python3 25 s,
node 51 s). The kernels and vs-native benches still spawn directly -
they subtract startup, so it only costs them wall time.
The full cold sweep through the broker (cache cleared, 164 case runs
in four chunks, zero failures) took **39 minutes**, against over an
hour before; the last chunk carries java-version, java-hello, ffmpeg
and node-jit and is 14 of those minutes.

### The shipped GIMP page on the current engine

The regression check that mattered: the shipped page had not been
rebuilt since Aug 30 (its embedded engine is exactly commit 95ff27e),
and rebuilding it exposed three things in turn.

1. A units-only repack cannot work once the emitter needs a runtime
   import the old shell lacks: units emitted after the loop yield
   import `env.loophot`, every recompiled unit failed to instantiate,
   GIMP ran interpreted and the File menu timed out. The page's
   snapshot memory image survives only as its sidecars, so a full
   xpack run is impossible; `tools/gui/reshell.mjs` splices the
   current engine modules into the shipped shell and swaps the units
   container, keeping state/mem/rom. xpack's fixed engine module list
   had gone stale on the way (xserver imports font5x7.mjs); both tools
   now walk the import closure.
2. With the current engine and even the shipped units, the File menu
   never appeared. A bisect over the 96 engine commits since 95ff27e
   (re-shell on each commit's engine, Chromium stroke check) named
   855590d - a node-only trace hook in the X server that read
   `process?.env?.XFONTTRACE` per atom/font request. `process` is not
   declared in a browser and optional chaining does not save an
   undeclared identifier: every InternAtom and OpenFont threw, and a
   menu popup needs both. The hooks now read the environment once,
   behind `typeof process`. A restore-side bug was fixed on the way (a
   restored engine had no mmap arena base, so the new hole list could
   hand live memory out twice); it was real, but not this.
3. Twenty-four stale headless Chromium instances from chains the
   hourly container restarts had killed sat on cdp_draw's fixed
   debugging port and answered its probes with a wedged page; the
   probe also bailed on a page still applying units at its first
   window query. Both fixed in the tool.

Shipped: the re-shelled page (current engine, 10 modules) with the
units recompiled by the current emitter (5,744 of 7,810 recompiled,
2,066 keep old bytes: trampolines and export-losing units; the
container is 88.1 → 86.4 MB raw with PIC jump tables). Chromium: File >
New > OK, five strokes, ink drawn, **19.8 ms median input-to-paint**
against 21.3 ms for the old page the same night. Suite exact.
`tools/gui/pagecheck.mjs` is the browser-side check that would have
caught it: serve the packed page, headless Chromium, File > New > OK,
two strokes, pass iff ink appeared - 17 s on the shipped page. It runs
alongside the sweep from now on; the node sweep cannot see a
browser-only failure.

A survey after the PIC tables: python3 structures 29 switch tables,
perl 30, bc 2. What the layout stats still list as "fallback" is the
dispatch layout in a handful of shared libc functions (`block/loop
overlap`): the switch is a `br_table` there too, inside the relooper
loop rather than in structured blocks. No translator item is left in
jump tables.

Gate for the xserver `typeof process` guard, the restore-side
`_mmapBase`, and the fork copy of the arena: the 164-case breadth
sweep on head 68dd1b2, cold wat cache, four chunks, 164/164
byte-identical to native in 39 minutes. Nothing shipped this batch
changes translation, so the sweep is a regression check, not a
performance measurement.

### Breadth batch 7: LLVM in-process (rustc, clang), gpg, a Rust binary

Five cases, five byte-identical: a `rustc -O` hello (HashMap, fmt,
f64 parse/print), `rustc --version --verbose` (the 147 MB
librustc_driver plus libLLVM 21), `clang -S -O2` on hello.c (the whole
-O2 pipeline, output compared as text, 171 s cold), `gpg --print-md
SHA256`, and a madvise fixture. Two kernel gaps fell out, both in
what madvise and mlock said rather than in translation:

- **`MADV_DONTNEED` did nothing.** jemalloc probes it at startup: fill
  a page, DONTNEED it, read it back; when the bytes survive it warns
  ("MADV_DONTNEED does not work (memset will be used instead)") and
  purges with memset. rustc carried the warning on stderr. Anonymous
  pages now read back as zeros and a private file mapping's pages
  re-fault from the file; shared mappings keep their pages (they hold
  dirty data the engine writes back lazily).
- **The file-mapping table kept stale entries.** munmap removed an
  entry only when the range covered it whole, and a MAP_FIXED overlay
  did not touch it at all. ld.so reserves a library's whole span,
  overlays the segments MAP_FIXED and unmaps the gaps, so reservations
  stayed on the table and anonymous pages in the reused holes were
  taken for file-backed: the first madvise cut refused to zero
  jemalloc's page because it "overlapped a file mapping". Partial
  unmaps and fixed overlays now trim or split the entries.
- **mlock/munlock/mlockall/munlockall** answered ENOSYS; gpg printed
  "Warning: using insecure memory!". They succeed now (nothing swaps
  here).

`cargo --version` through the rustup proxy fails the same way native
would without `~/.rustup/settings.toml` ("no default is configured"),
so it is not a case; the toolchain's own cargo is.

### The rustc compile: a PIC-table guard that was a case test

`rustc -O --emit=asm` on a two-function crate (LLVM optimising and
emitting in-process, seven threads, 1,974 units, 1 GB of wat) died
after 188 s with a wasm out-of-bounds access in a translated LLVM
function. The function's memory matched the file (a new
`TEXTCHECK=1` lever in runbin compares every mapped file's guest bytes
with the file at exit: only data segments differed, all relocation
targets), and the run failed identically on the previous engine, so
it was not the day's mapping change. The dumped unit showed the
translation of an entry at a bare `jmp rel32` starting one byte late:
`push rbp; add [rax],eax; ...` are the jmp's own bytes from +1. The
analyzer's block for the entry held the `jmp` *and* the instructions
decoded from +1, so the emitter, which handles a jmp only as a block's
last instruction, dropped it and ran into the misaligned stream.

The misaligned stream came from a PIC jump table read with 32 entries
where the switch had 11. In `SemiNCAInfo::FindRoots` LLVM bounds-checks
a copy of the index (`lea -0x1e(%rax),%ecx; cmp $0xb,%cl; jae`), then
tests one case on the original (`cmp $0x1f,%eax; je`), then subtracts
and loads. The guard finder walked up from the load and took the first
`cmp $K, %idx` it met, the case test, as the bound. Two of the 32
"entries" pointed inside real instructions, and one of the phantom
leaders sat one byte past the `jmp` the fatal entry was rooted at.

The rule is now: the guard is the compare an unsigned branch consumes.
`ja`/`jbe` make K the last index (K+1 entries); `jae`/`jb` make K the
count. A `cmp` on the index that any other branch consumes ends the
walk with no table (the jump stays an indirect-jump deopt, which is
correct and merely slower). The `jae` form had been off by one all
along, reading one entry past every such table; the extra entry
happened to land on plausible code in python and perl. Three shapes
are pinned in `engine/diff/picguardtest.mjs` (ja, jae, and the
FindRoots shape), each also checked for overlapping decode. rustc's
compile then runs to completion with the assembly byte-identical to
native.

The guard fix removes the cause; a check in the analyzer removes the
failure mode. After block formation every function is now refused when
two decoded instructions overlap or when a jmp, jcc, ret or indirect
jump sits anywhere but last in its block, and a deopt point always
ends its block (the label after it starts a new one). A refused
function stays interpreted: slow and right, where the emitted unit was
fast and wrong. The check costs one pass over the sorted addresses.
`picguardtest` pins a jump into the middle of an instruction as
"overlapping decode".

The first cut refused seven malloc-path functions in every program:
glibc branches one byte into `lock cmpxchg` to run the plain
`cmpxchg` when the process is single-threaded, so two instructions
share their last four bytes. That overlap is allowed when both end at
the same address, and that address becomes a block leader so the two
paths rejoin there; before, the lock path fell through into the
middle of a block and deopted on every execution. Function counts are
back to their earlier values (awk 537, python 2350) with no refusals
reported under the new `AOTFAIL=1` breadth lever, which prints each
refused translation with its reason, bytes and image.

Gate for batch 7, the guard rule and the integrity check: the cold
breadth sweep on head fc3f6f3, five chunks plus the four cases the
chunk list's substring filter missed, 175/175 byte-identical to native
in 58 minutes (rustc-asm 642 s and clang-S 231 s of it). Two notes for
the next sweep: the chunk list is read by substring, so a name like
`java-version` does not pick up `java-hello`, and a background run
only survives while the session stays active: the container is
reclaimed when the session idles, which killed two earlier attempts
mid-chunk.

### Breadth batch 8: cargo builds a crate

`cargo build --offline` on a no-dependency crate is a process tree:
cargo probes `rustc -vV` and `rustc --print` over pipes, then spawns
the compile, which spawns `cc` for the link, which runs collect2 and
ld. Three things fell out before rustc ran at all:

- **Child engines had 256 MB.** The default suits GIMP's plug-ins; a
  rustc child could not map its 265 MB of shared libraries and ld.so
  exited 127, which cargo reported as `rustc -vV` failing. The size is
  now an option (`childMemMB`, runbin `CHILDMEM`) and grandchildren
  inherit it.
- **`socketpair` was ENOSYS.** std's spawn reports exec failures to
  the parent over a CLOEXEC socketpair, and cargo's compile spawn
  takes that path (a `pre_exec` hook for the jobserver rules out
  posix_spawn). AF_UNIX stream pairs are now two crossed pipe buffers:
  each end reads its own and writes its peer's, the pipe helpers
  (reader/writer liveness, EOF sweep at close and exec) understand the
  `peer` field, and `recv` on such an end drains like `read` (std
  reads the channel with recv; the first cut answered ENOTSOCK and
  cargo's worker thread panicked). The `sockpair` fixture pins both
  directions, poll readiness, EOF after the peer closes, and a child
  on the other end.
- **Seeing the children.** Children are reaped out of `eng.children`,
  so a run-loop sweep misses ones that live inside one slice; the
  engine now offers an `onChildEngine` hook (inherited by
  grandchildren) and runbin's `KIDS=1` prints every child's argv,
  exit, stderr and syscall tail. `STRACEERR=38` prints every syscall
  answering a given errno as it happens, which is how socketpair was
  found among statx, clone3 and rseq (all ENOSYS by design, with glibc
  and std fallbacks).

Then rustc ran under cargo and died with a JavaScript RangeError, the
parent recording the child as exit 127 and cargo waiting on a pipe that
never closed. The child's error stack (kept on the child record now)
pointed at getrandom: Rust std probes availability with a zero-length
buffer at a dangling pointer (address 1), Linux answers 0 without
touching memory, and the engine's zero-byte copy to a negative offset
threw. Zero-length getrandom now answers 0 whatever the pointer, and a
pointer outside guest memory answers EFAULT instead of throwing.

With rustc through, the link failed: rust-lld rejected an empty
`-plugin-opt=`. gcc expands `%(lto_wrapper)` in its link spec from
wherever it found `lto-wrapper`, and with that file not provisioned the
option is empty; GNU ld tolerates it, rust-lld does not. A provisioning
matter, recorded on the case. The remaining warning, "error finalizing
incremental compilation session directory", was rename(2) on a
directory: directories exist here as path prefixes plus the mkdir set,
and rename moved a single file entry. A directory rename now moves
every entry under the prefix (files, symlinks, mkdir'd subdirectories,
mtimes); renameat and renameat2 (NOREPLACE) route to the same code.
The `renamedir` fixture pins the tree move, an empty directory, a
directory over a file, a move into itself and NOREPLACE.

`cargo build --offline` on the crate then finishes in 468 s cold with
the binary byte-identical to native's: cargo, rustc (7 threads), cc,
collect2, ld.lld and rust-lld, 3,805 translated functions across the
tree. Two host-loop lessons from the chase: signal handlers never fire
while runbin's loop is synchronous, so state is sampled through files
(`SAMPLEFILE` prints the tree and continues, `STOPFILE` prints and
exits), and children reaped inside one run slice are invisible to a
sweep of `eng.children`, hence the `onChildEngine` hook.

With the directory rename in, the case's guest stderr is native's two
lines exactly ("Compiling", "Finished"); the warning is gone.

### The harness was eating the box, not the engine

The gate sweep after batch 8 lost a chunk to the OOM killer at 13.7 GB
RSS after fifty cases, and the next chunk was at 12 GB with seven
cases to go. With `--expose-gc` and a collection between cases the
RSS stays flat at 4.5 GB, so nothing leaks: V8 simply never collected
a finished case's `WebAssembly.Memory` under its own pressure
accounting. The harness now collects between cases (a no-op without
the flag; the sweep script passes it), and the 4 GB floor was the
library provisioning read twice, once under `/lib` and once under
`/usr/lib`; the bytes are shared by realpath now, as runbin already
did (its probe baseline went 4.3 GB to 1.5 GB earlier today).

Gate for batch 8 on head cb8d07c: every defined case green (chunks 1-4
of the sweep, 158 passes, plus the 21 cases the killed chunks had not
reached, run separately with `--expose-gc`). One thing the memory
lines show even with collection: after cargo-build and rustc-asm the
host keeps ~2.7 GB of JS heap and ~12 GB of wasm memory that light
cases never free; something in a run with children or threads is
retained after the case ends. Open item.

The retainer, from a heap snapshot of a three-minute reproducer (cargo
on a crate with a syntax error, then a light case, then `gc()`): every
surviving engine hung off a pending `WebAssembly.instantiate` promise
(V8's `AsyncInstantiateCompileResultResolver` global handle) whose
`.then` reaction captured the engine. The per-binary child unit cache
hands a repeat spawn its compiled units through that async path, and a
synchronous host never returns to the event loop while the guest runs,
so the promise stayed pending for the whole job. Two consequences: the
repeat child never received its cached units and ran them interpreted,
and the reaction pinned the child, its parent through `parentEng`, and
every 2 GB memory. cargo spawns rustc three times, which is why only
the cargo cases retained. Cached units are now instantiated in line
unless the host asked for off-thread compilation (`asyncCompile`) or
is a browser. Interpreter-only runs never retained, which was the
first bisect. The tools that found it: `BREADTH_MEM=1` per-case
memory lines, a reproducer that drops the engine and collects, a
181 MB heap snapshot, and `scratchpad/snapwalk.py`, a numpy retainer
walk that prints the root-to-object chain (five seconds on this
snapshot).

After the fix the reproducer frees everything (heap 10 MB, external
memory back to the provisioning floor), the cargo run itself is 162 s
to 125 s because the repeat rustc children now get their cached units,
and in the harness the case after cargo-build sees 61 MB of heap and
2.5 GB external where it saw 2.7 GB and 12 GB. Six child-spawning
cases stay byte-identical.

`engine/test.sh` (the differential suite: hardware cases, jump tables,
dispatch layout, packed ops, flags, rcl/rcr, picguard, threads) is
green on b642e2e; the full breadth sweep with `--expose-gc` runs at a
flat ~2.3 GB per chunk where the killed chunks had climbed past 12 GB.

Clean gate on b642e2e: the five-chunk cold sweep with `--expose-gc`,
181 passes, 0 failures, no chunk killed, 67 minutes, every chunk flat
at 2.3-3.8 GB except while cargo-build's own tree runs.

### Where a compiler-scale run spends its time

`OXWASM_PHASE=1` on rustc-asm (rustc -O emitting assembly for a
two-function crate, 20,464 translated functions, 3,329 units, 1.77 GB
of wat): of 778 s wall, analysis took 305 s, emit 152 s, inlining 16 s
(the funcref scan is nothing). Translation is 61% of the run before
the assembler's own time is counted, and 4,110 unit translations
re-emitted 13,176 functions, so closure duplication is a large part of
it. For programs of this size the engine is translation-bound, not
execution-bound: an analysis cache keyed by function address (valid
until the code's pages change) and less closure duplication are the
levers, and they belong to the steady-state work rather than to
breadth.

### Breadth batch 9 opens with make -j2: four signal gaps

`make -j2` on a three-target Makefile parked after its first two
recipes. Four things, each needed for the fix:

- **ppoll/pselect6 ignored their signal mask.** make blocks SIGCHLD
  and waits in pselect6 with a mask that admits it. The wait now runs
  under the temporary mask (SIGKILL/SIGSTOP stay unblockable): a
  newly admitted pending signal is delivered at once with EINTR, an
  interrupting signal restores the caller's mask through the signal
  frame, and a normal return restores it in line.
- **An interrupted wait left its deadline behind.** Only nanosleep's
  EINTR path cleared `_deadline`; an interrupted ppoll left Infinity,
  and the next ppoll with a 30 ms timeout inherited it and never
  returned. Every sleepy syscall's EINTR path clears it now.
- **A vfork-window child's sigaction wrote the parent's table.**
  posix_spawn resets the spawnattr signals to SIG_DFL in the child
  before exec; with one process-wide table, make lost its SIGCHLD
  handler as soon as it spawned a job, and the second job's exit was
  discarded as default-ignored. The window child now gets its own
  copy, which goes with it into the exec'd image (ignored signals stay
  ignored across exec, as on Linux).
- **SA_RESTART restarted pselect6.** signal(7): select, poll, epoll
  and nanosleep are never restarted after a handler. Restarting ran
  make's handler and went straight back to sleep. A NORESTART set
  covers them.

Found with the `pselect` fixture (blocked SIGCHLD, a child exiting
during pselect and ppoll, a timed ppoll, a ready fd) and the
`make-j2` case (parallel recipes through sh, the jobserver pipe, the
output file compared to native). The signal-heavy cases (signal,
timers, bash-trap, sigpipe-sh, make, cmake-P) stay exact. Also fixed
on the way: a trailing comment in runbin had swallowed the SIGTRACE,
AOTFAIL and DBG levers on the same line, which is why the first
traces printed nothing.

A CPU profile of clang-S (262 s, `--cpu-prof`, warm wat cache) splits
the run differently from the phase counters: 67 s (25%) is the host
blocked in `read` on the assembler broker's fifo, i.e. wat2wasm's own
time on 2.05 GB of text; 41 s (16%) is garbage collection, almost all
of it the emitted strings; emit proper is about 55 s (`emitUnitFunction`
39 s self plus block emission); analysis, decoding and block formation
about 26 s; wasm instantiation 6 s; and `_knownEntries`, rebuilt from
three maps on every unit, 7 s. The text volume is the common root of
three of those: at 50 KB of wat per function nothing in it dominates
(leading whitespace 9%, the wrapped-register address form 10%, the
32-bit masks 6%), so a real cut means emitting something denser than
this wat. Landed from this profile: a poisoned callee re-emits only
the texts that reached it (13k re-emits in the rustc compile were a
third of its emit phase), and the known-entries set is incremental.
The next lever is structural: hand the broker a unit and keep running
while it assembles, registering the module when the bytes come back,
as the browser already does with its off-thread assembler.

Measured on rustc-asm with the selective re-emit: re-emitted
functions 13,176 to 789, emit 152 s to 113 s, wat text 2.79 GB to
2.07 GB (less to assemble and collect), the run 778 s to 731 s with
the same 3,329 units and 20,464 functions. Analysis is unchanged at
298 s and is the next target.

### Deferred assembly: the guest runs while wat2wasm works

The clang profile put a quarter of the run in the host blocked on the
broker's fifo. The broker now takes a submission and answers later:
`asm.submit(wat, cb)` writes the text and the request line and returns;
`asm.pump()` reads whatever status lines are back (the fifo is opened
non-blocking; the shell answers in request order, so each line belongs
to the oldest pending job) and runs the callbacks, which instantiate
and register the unit. The engine's `assembleWatDeferred` path sets the
same null placeholder the browser's off-thread compile uses, counts the
unit's functions as seen for closure pruning while they are pending,
and pumps at every run slice and every tier-up; a synchronous request
behind pending ones drains them first. Child engines inherit it. Cold
(every unit through wat2wasm), byte-identical: gcc-c 68 s to 54 s,
m4 13.9 s to 11.7 s, python3 39 s to 37 s. Opt-in as `ASYNC_ASM=1`
in runbin and breadth until the sweep has run under it.

clang-S cold under deferred assembly: 231 s to 203 s (12%), exact. The
fifo wait was a quarter of the synchronous run, so half of it is now
overlapped; the rest is wat2wasm still being one process behind the
translator's output rate (a second broker shell would take the other
half).

The full sweep ran under deferred assembly: 182 cases, byte-identical,
zero assembler errors, 44 minutes in five chunks. Deferred assembly is
now the default in both harnesses (`ASYNC_ASM=0` restores synchronous
assembly for A/B). The second broker shell was tried
(`OXWASM_ASM_WORKERS=N` adds shells) and gained nothing measurable on
m4 or gzip under the sweep's CPU contention; it stays opt-in.

### What the analysis histogram said, and the lever it pointed at

The phase profile (`OXWASM_PHASE=1`) now counts analyses, instructions
analysed, distinct entries, duplicate analyses and their time, and
buckets analyses by size. On clang-S: 15,329 analyses over 11,303
distinct entries, linear at 4.4-5.5 µs per instruction in every size
bucket, so there is no super-linear bucket to fix; the duplicates
(26% of analyses) are the tiny callees deliberately re-analysed into
every unit and cost 118 ms of 1.6 s on the gated run below. An
analysis cache by address is not worth building. A cheaper fetch
(one region lookup per instruction instead of one per byte) took
analysis on rustc --version from 2404 to 1939 ms; that is the
per-instruction lever, and it is small.

The large lever was in what gets analysed at all. A per-function entry
counter (`OXWASM_FNPROF=1`, now with a histogram) on rustc --version:
1,259 functions translated, 244 of them roots the call profile made
hot; 733 were never entered after translation and 250 more fewer than
four times. The closure walk was translating the cold branches of hot
functions: every call target reachable from a root, whatever the
profile said about it.

**Profile-gated closure.** The closure now skips a callee the call
profile has never seen called (tiny callees excepted, as before); a
gated callee that turns out hot is profiled at its callouts and tiers
up as its own root, and its call sites then hit through `$ftr`.
`OXWASM_CLOSURE_ALL=1` restores the ungated walk. Measured, all exact:

| run | ungated | gated |
|---|---:|---:|
| rustc --version, functions translated | 1,259 | 587 |
| rustc --version, wat text | 69 MB | 34 MB |
| rustc --version, wall | 12.1 s | 9.7 s |
| clang -S -O2 hello.c (runbin, deferred assembly) | 203 s | **51 s** |
| clang -S, functions translated | 11,303 analysed | 4,436 |
| clang -S, emit / analyze | 51.6 s / 35.4 s | 15.7 s / 8.6 s |
| breadth clang-S (warm wat cache) | 203 s | 37 s |
| breadth python3 | 37 s | 18 s |

Steady state is unaffected where it was feared it would be: m4 on the
3.3 MB input, two interleaved rounds, gated 8.55x / 8.47x against
ungated 9.02x / 8.48x (noise band), and the gated small run starts
2.5 s sooner. Differentials green. The gated clang run still shows
1,838 translated functions never entered and 867 entered fewer than
four times: these callees were seen called once to three times before
their caller tiered up. `OXWASM_CLOSURE_MIN=N` prices the gate at N
observed calls: at 3, clang -S 50 s to 45 s (wat 390 MB to 288 MB,
emit 15.2 s to 11.7 s), rustc --version 646 to 556 translated
functions, and m4 steady state 8.70x / 9.00x against 9.22x / 9.76x at
1 (interleaved rounds under a running sweep; not worse). The sweep over
the gate at 1 was green (182 cases in five chunks); the default is now 3
and the sweep runs again over it.

Two more items from the gated clang profile (46 s): the call-target
string set passed to the analyzer was rebuilt from the whole profile at
every tier-up, 5 s of the run at 2,900 units (now kept incrementally);
and module instantiation was 7 s, V8 compiling every function of every
unit eagerly although most are never entered. `WASM_LAZY=1` in the
harnesses sets V8's lazy wasm compilation: clang -S 45 s to 39 s, exact.
On m4 steady state it read 9.16x / 8.89x against 8.99x / 8.59x eager,
both rounds leaning the same way inside the noise band. On the idle
machine, two interleaved rounds: lazy 7.05x / 7.28x against eager
7.06x / 7.15x, neutral, so lazy compilation is now the harness default
(`WASM_LAZY=0` restores eager); a six-case compiler subset is exact under
it, clang-S 27 s to 20 s warm. (The idle-machine m4 figure itself, 7.05x
against 8.5-9x for every measurement taken while a sweep ran, says how
much the day's absolute numbers carry the sweep's contention; the A/Bs
were interleaved, so their comparisons hold.)

Three smaller items from the same profile. The emitted wat carried a
six-space indent on every line, 9% of a unit's text; dropped, unit
text is 6% smaller and emit time unchanged (the emitter's cost is not
in the characters). A second broker shell for deferred units was
priced a third time, on clang -S this time (37.5 s / 39.6 s against
38.2 s with one): null, so it stays opt-in. And the synchronous
assembler path, which PLT stubs of a few lines take, waited behind
every deferred closure unit ahead of it in the queue - 1.3 s of the
40 s clang run for stubs that assemble in a millisecond; synchronous
requests now have their own shell, clang -S 38 s to 34-36 s.

What the gated clang profile (40 s) leaves: the emitter 4.7 s self plus
4.5 s of garbage collection, 3.9 s of module instantiation even with
lazy compilation, 2.9 s of decode plus analysis, 1.6 s interpreting
2.5M steps, and the guest's own translated execution. No single bucket
is above 12%.

**A race the deferred path opened.** The sweep over the new defaults
failed one case in 182: recycle, the page-recycle fixture (tier code A
on an rwx page, munmap it, map code B at the same address), printed
A's answer once. munmap drops address-keyed translations, but a unit
still in the assembler's queue is not in any table yet; when its bytes
came back it registered A's translation over B's page. The browser's
off-thread compile has the same window. Both paths now record in-flight
units; invalidation (munmap, mremap) cancels those holding any address
in the range, and a cancelled unit is discarded when it lands.
Invalidation also clears the call profile, the closure-pruning set and
the known-entry set for the range, so recycled code profiles and joins
closures afresh rather than inheriting the old code's history.

The sweep over the new defaults (gate at 3, incremental call targets,
deferred assembly) was 181 of 182 exact, the one failure being the
recycle race above; the chunk that held it is rerun under the fix. The
compiler-scale cases, warm wat cache, against the same harness before
the gate: rustc-asm 642 s to **158 s**, cargo-build 350-390 s to
**148 s**, clang-S 203 s to **27 s**, java-hello 98 s. The whole sweep
took 32 minutes against 58 before batch 8.

**Failed callees were re-analysed in every unit that reached them.** The
phase profile of the gated rustc-asm (152 s) put 41.6 s in analysis and
35.2 s in emit, and 5,797 of its 12,104 analyses were duplicates - not
the tiny callees this time but 2.58M instructions, 9.8 s. A callee whose
analysis or emit fails (LLVM functions with unsupported SSE forms, the
routine case) is poisoned in its unit and registered nowhere, so the
next unit that reached it analysed it from scratch and failed the same
way. The engine now keeps a failure memo across units (cleared per
range with the other invalidation): a memoised callee is poisoned
without analysis. rustc-asm: analysis 42.5 s to 35.4 s, duplicate
instructions 2.58M to 0.44M, the run 156 s to 143 s; 312 memo hits.
Roots are never memoised, so a function that fails as a callee still
gets its own attempt when its profile makes it a root.

**Size gate.** Joining the per-function entry counter with the analysis
sizes on rustc-asm: 549 translated functions of 2,000 instructions or
more held 2.44M instructions, and 76% of those instructions belonged to
functions entered fewer than 16 times after translation (161 never).
A giant costs its instruction count to emit, assemble and instantiate,
and the call threshold of 4 does not know its size. The engine now asks
for more observed calls the bigger the function: max(threshold,
n >> 6) capped at 256 (2,000 instructions need 31 calls, 13,000 need
203). A root that falls short is deferred, not failed - profileTarget
re-tiers it at the count the gate named; a callee that falls short
stays out of the closure and its size is remembered so later closures
refuse it without analysing it again (without the memo, analysis went
UP 8 s: every closure re-analysed the refused giants). Loop-head roots
are exempt as roots (their heat is proven on back edges) but their
giant callees are gated like any other. `OXWASM_SIZEGATE=0` turns it
off, `OXWASM_SIZEGATE_SHIFT` moves the slope.

rustc-asm on the idle machine: 109 s (analysis 25.7 s, emit 23.0 s;
against 143 s under contention with the failure memo alone), breadth
96 s warm; clang-S 27 s to 16 s warm; m4 steady state interleaved
7.92x / 7.68x gated against 8.71x / 7.70x ungated. The sweep over the
failure memo and lazy compilation was 182 of 182 exact (the last chunk
already ran with the gate); rustc-asm, clang-S, python3, gzip, m4 and
recycle exact under the final gate.

The sweep over the size gate: 182 of 182 exact in 21 minutes on the
idle machine (58 before batch 8, 32 after the closure gate). Warm
compiler cases in it: cargo-build 101 s, rustc-asm 98 s, java-hello
72 s, clang-S 15 s.

**Garbage collection is the largest bucket left.** A CPU profile of the
gated rustc-asm (120 s sampled): GC 27 s (22%), the emitter 14.5 s
self, analysis with decode 20 s, module instantiation 7.5 s. `--trace-gc`
says which collector: 7,448 scavenges totalling 24.3 s at 3.3 ms each,
and 25 mark-compacts totalling 0.2 s. At a 16 MB young generation that
is on the order of 120 GB allocated over the run for 750 MB of wat
text, and the 3.3 ms per scavenge (a near-empty scavenge is well under
a millisecond) says a unit's working set - its analyses and block texts
- survives and is copied while the unit is being built. A 64 MB
semi-space (`--max-semi-space-size=64`) took the run from 110.8 s to
103.9 s; 128 MB gave nothing more. The sampling heap profiler only
reports what is live, not the allocation rate, so attributing the
120 GB to functions needs a different instrument; the candidates are
the per-instruction emit strings, the analysis objects, and the
narrowing pass's regex results. Not pursued further today.

### Batch 10 probes: javac, go build

`go build hello.go` (go 1.24) fails after 234 s with the Go runtime's
own "out of memory: cannot allocate 4194304-byte block (0 in use)"; its
`go version` case passes. The mmap trace explains it: the runtime asks
for its 64 MB heap arenas at hinted addresses (0xc000000000,
0x1c000000000, ... in 1 TB steps) with PROT_NONE, and reserves two
512 MB regions for its page-allocator summaries the same way. The
engine's guest is a flat 3 GB window, so a reservation costs the same
address space as a mapping; 109 successful mmaps summed to 7.5 GB with
unmaps in between, and the arena requests at the end got ENOMEM. The
go parent also interpreted 408M steps in those 234 s with 10k compiled
runs, a tiering gap of its own. Address-space reservations that a
48-bit process takes for free are a structural limit of the flat
window; `memMB` up to ~4090 (the wasm32 ceiling) is the only lever.

`javac Hello.java` (OpenJDK 21, -Xint) dies in translated code with a
wasm "memory access out of bounds" in libjvm; `java Hello` with the
same flags passes. The trap comes 386 s into the run, in a chain of
frames at 0x1406xxx (a library loaded low, before libjvm at 0x3168e000;
one frame is a 45 KB function, the shape of libc's vector memcpy or
strlen family). The probes so far are inconclusive by cost: javac
interpreter-only did not finish in 18 minutes; with the trapping
function vetoed from translation it neither trapped nor finished in 15;
the 4 GB run was host-OOM-killed while another 3 GB guest ran. Next:
`LIBOF=hex,hex` in runbin (new) names the mapping of each trap frame
after a short `GUARD`-bounded run, then the function's bytes decide
between a translation fault and a vector over-read at the top of the
guest window.

**javac root cause: a longjmp through translated frames.** A 300-line
fixture (`tools/fixtures/dlfail.c`: dlsym of a missing symbol and
dlopen of a missing library, 300 times each) reproduces the javac trap
in two seconds and bisects to one function: veto ld.so's `__longjmp`
from translation and it passes. The failing path: `_dl_catch_exception`
sets up a jmp_buf, the lookup fails, `_dl_signal_exception` calls
`__longjmp`, which restores a caller's rsp and ends in `jmp *%rdx`.
Two engine mechanisms each assumed the guest frame under them was still
there:

- *Nested frames.* A callout runs the callee to completion by
  interpreting until the guest returns to the call's return address at
  the frame's exit rsp; the deopt handler runs a landing nested inside
  the deopting frame. After a longjmp the guest never returns there.
  The nested interpreter kept going inside the abandoned frame, one
  level deeper per dlsym miss, until the JS stack overflowed ("Maximum
  call stack size exceeded" with everything else vetoed). Both sites
  now watch for rsp rising above the frame's exit level and unwind the
  wasm frames to the top loop, which resumes at the landing from the
  published register file.
- *Tail-jump chaining.* Once `__longjmp` itself tiered up, its
  `jmp *%rdx` chained through the dispatch table as a wasm tail call
  into the landing's compiled continuation - splicing that continuation
  into the longjmp's own frame. When the continuation returned, the
  wasm return resumed `_dl_signal_exception`, the function the guest
  had abandoned, which ran its post-call code with rsi=1 and trapped
  out of bounds. Tail jumps now chain only while rsp is at or below the
  frame's entry rsp; above it they deopt, and the unwind above takes
  over. (`rdsspq`, `incsspq` and the rest of glibc's CET shadow-stack
  code decode as nops and take the no-shadow-stack path, as on
  hardware without CET.)

Found with a trace of callout entries, frame completions and unwinds
(`FRAMETRACE=1` in runbin) plus `wasm-objdump` on the unit to map V8's
trap offset to the instruction (`mov 0x8(%rsi),%rcx` after the call).
dlfail is a breadth case; recycle still exact; differentials green.

With the longjmp fixed, javac no longer traps - it ran 15 minutes
without finishing. A state sample said why: 594M interpreted steps at
343 s, 1.9M steps/s, translated runs barely growing. The JVM's template
interpreter is generated at startup into anonymous PROT_EXEC memory,
and `execRanges` (what the profiler counts as code) only ever held
file-backed text: the JVM's own interpreter, which runs every bytecode
under -Xint, could never tier up. `OXWASM_EXEC_ANON=1` (opt-in) counts
anonymous PROT_EXEC mappings as code and drops them at munmap. java
hello: 77 s to 31 s, output exact. javac then reaches a Java-level
failure in 42 s - an `instanceof` in `Context.put` came out wrong
(AssertionError "T extends Context.Factory") - so some translated JVM
path miscomputes; a unit bisect (`UNITVETO` ranges, 3,200 units) is
running. Opt-in because code written into such memory can change
without an munmap (a JIT's code cache), and the engine invalidates
translations only on munmap/mremap; the -Xint interpreter is generated
once.

**Two flag bugs under the wrong instanceof.** A fixture for the rep
string operations the JVM's subtype check is built on (`repscan.c`:
`repne scasq`, `repne scasb`, `repe cmpsb`, with hits at the first and
last element, misses, and rcx=0) disagreed with hardware in two ways,
both in translated code:

- *rcx=0.* Hardware leaves the flags untouched; the translator modeled a
  rep-prefixed cmps/scas as a definite flag writer, so the compare
  before it was dead by the liveness analysis and never materialized,
  and a consumer after a zero-count scan read stale lazy operands. A
  rep cmps/scas is now also a consumer of the incoming flags: the
  producer materializes, and when its (kind,size) matches the scan's
  the untouched locals are exactly right; otherwise rcx=0 escapes to
  the interpreter.
- *Escapes.* pushf, x87, cpuid and the other instructions a unit refuses
  end the block and hand the frame to the interpreter - which carried on
  with whatever flags it had last computed itself: the lazily kept
  flags were never handed over. `repne scasq; pushfq` read ZF=0/CF=1
  for an equal compare. An escape is now a soft flag consumer too: the
  unit stores EFLAGS (computed from the lazy state for the sub/add/logic
  kinds, bit 63 as the valid marker) in regfile slot 136, and syncIn
  applies and clears it. A soft consumer never poisons a function: an
  unknown producer just hands nothing over, as before.

Both fixture variants (pushf and setcc readback) are byte-identical to
hardware now; repscan is a breadth case; differentials green.

With the two flag fixes, `javac -J-Xint Hello.java` compiles under the
engine: 416 s, and the class file is byte-identical to native javac's.
It is a breadth case (`javac`, with `execAnon` as a per-case engine
option children inherit; java-hello stays without it so both paths are
covered). Batch 10 therefore lands four engine fixes that had nothing
to do with Java in particular: a longjmp through nested frames, tail
chaining across an abandoned frame, flags not handed to the interpreter
at escapes, and zero-count rep scans - each with a two-second fixture
(dlfail, repscan) that reproduces what took javac six minutes to reach.
The sweep over all of it: 186 of 186 exact in 28 minutes (javac 385 s,
cargo-build 107 s, rustc-asm 108 s).

**mprotect as the W^X signal.** Under execAnon, mprotect now drives the
exec ranges: a range made PROT_EXEC becomes code (V8 maps its code pages
RW and flips them RX, so the mmap never said exec and node's JIT output
had stayed invisible), and a range made writable-without-exec is about
to be rewritten, so its translations are dropped. That makes W^X JITs
sound under the lever; node-jit 33 s to 28 s exact, java-version 27 s
to 16 s. In-place RWX rewriting (HotSpot with C1/C2 on, LuaJIT) has no
such signal, which is why execAnon stays opt-in; the breadth cases that
want it (javac, java-version) set it, java-hello runs without it so both
paths are covered.

**The guard itself was javac's 385 s.** A CPU profile of the javac run
put 61 s in the deopt handler alone, 56 s in the run loop, 33 s in
dispatch, 22 s in syncIn and only 3 s in translated code: 41M deopts in
400 s, one per Java bytecode. HotSpot's template interpreter dispatches
every bytecode with `jmp *(%r10,%rbx,8)` and uses rsp as the Java
operand stack, so at the jump rsp is routinely above the template's
entry rsp - exactly what the tail-chain guard above takes for an
abandoned frame. The guard only matters for a NESTED frame, where a
translated call site waits on the return; a top-level frame (nesting
word zero) has its exit rip honoured, so whatever a chain eventually
returns to is simply where the guest goes next. The guard now lets a
top-level frame chain regardless of rsp. javac: 400 s to 37.6 s, deopts
41M to 20k, interpreted steps 356M to 6M, class file still exact; java
hello 31 s to 20 s; dlfail still passes (its longjmp runs under a
nested call site). `DEOPTLOG=1` and `IHIST=1` in runbin print the deopt
landings and the interpreted rips by library - what said "bytecode
dispatch" in one look. The sweep over the relaxed guard: 186 of 186
exact in 21.5 minutes; javac 29.6 s warm.

**The JIT-on JVM says what execAnon cannot be.** `java Hello` with C1/C2
enabled runs correctly with execAnon off (92 s; its compiled nmethods
carry `ss:`-prefixed padding, which the decoder refused - es/ss are null
prefixes in 64-bit mode like cs/ds and are accepted now; gs stays
refused as a real segment base). With execAnon ON it faults at a
different wild address on every run: HotSpot patches call sites and
inline caches in place in its RWX code cache, and a translation of the
old bytes keeps running. No mprotect, no munmap - no signal. That is
the case that keeps execAnon opt-in; `java-jit` is a breadth case
without it.

Two more probes. ffprobe over a lavfi test source is a breadth case
(exact). Valgrind's memcheck tool (a static binary with its own address-
space manager and JIT) dies at startup with an aspacem assertion: it
expects to own the process address space from its 0x58000000 load
address up, and the flat window's layout is not that - parked with go
build as an address-space shape the window does not offer.

### Batch 11: archive tools, and directory order

curl over a file URL, `unzip -l` and `zip -r` of a small tree are breadth
cases. zip's archive differed from native's in entry order alone: zip
prepends what readdir hands it, and the engine had listed directories in
provisioning order, which came from `fs.readdirSync` - libuv sorts that.
Provisioning now walks with `fs.opendirSync` (the host's getdents order),
so a guest directory lists in the same raw order as the host's, and zip,
tar, find and `ls -U` see what native sees. runbin gained
`STDOUTFILE=path` (raw guest stdout) for this kind of byte comparison.
The sweep with java-jit in it: 188 of 188 exact in 24 minutes.

### Batch 12: a syscall census

`tools/fixtures/census.c` calls what the ordinary breadth binaries never
do and prints each result as `name=ret/errno`, so native and engine
compare byte for byte: fallocate, statx, user xattrs, utimensat,
renameat2 with NOREPLACE and EXCHANGE, flock, sendfile, copy_file_range,
pipe2 flags, splice both ways, eventfd, epoll over it, timerfd,
signalfd, memfd_create with a MAP_SHARED view, inotify (create events
on a watched directory), sysinfo, uname, prlimit64, sched_getaffinity,
getcpu, sched_yield, gettid, tgkill(0), clock_getres, nanosleep,
symlinkat/readlinkat, fchmodat, unlinkat, getrandom. First run: 71
native lines against a hang - `pipe2(O_NONBLOCK)` ignored its flags and
a read on the empty pipe blocked forever. Then, line by line: fallocate,
sendfile, copy_file_range and splice (ENOSYS before; byte-level
transfer helpers over files, pipes and the default stdout/stderr sinks),
memfd_create (an anonymous regular file; a pread through it absorbs its
MAP_SHARED pages first, so the mapped write is visible), inotify
(init/add/rm, IN_CREATE/IN_DELETE from open, mkdir, unlink and rmdir,
readable through poll/epoll), user.* xattrs per path, RENAME_EXCHANGE
(ENOENT when a side is missing, a swap when both exist), chmod family
remembered per path and reported by stat, sysinfo's process count,
readlinkat's EINVAL on a non-link. One regression on the way: sendfile
consumed its input before discovering stdout was a sink it could not
feed, and busybox's `cat` (which sendfiles to stdout and falls back on
EINVAL) printed nothing - the shell differential caught it; the sinks
are resolved before any read now. The census is a breadth case.

### Batch 13: the second census, and a local socket layer

The first census paid for itself in a morning, so a second one covers
what it skipped: `tools/fixtures/census2.c` (151 lines native) runs
processes, signals, memory and sockets - prctl names, personality,
sigqueue with a value, sigpending/sigtimedwait, sigaltstack, setitimer,
pidfd_open, waitid, a child killed by SIGTERM, mincore, madvise on an
unaligned address, mremap keeping its bytes, msync, writev/pwritev/
preadv, dup3 and F_DUPFD_CLOEXEC, FIONREAD, statfs, SEEK_HOLE, a
negative lseek, getdents64 with the d_type of an entry, faccessat X_OK
on a 0600 file, mkdirat/unlinkat/openat error paths, chdir/fchdir, a
socketpair carrying a descriptor through SCM_RIGHTS, MSG_PEEK and
MSG_DONTWAIT, SO_TYPE, shutdown(SHUT_WR) and the EPIPE after it, an
AF_INET server on the loopback (bind port 0, listen, connect, accept4,
getsockname's port, TCP_NODELAY, ppoll on the accepted end, getpeername,
a refused connect), an AF_UNIX datagram socket bound to a path (stat
says S_ISSOCK, sendto/recvfrom), close and fstat on a bad descriptor.

The first engine run crashed inside read(2): a directory handle has no
bytes. Then, once the run went through, twenty-two lines differed.
The sockets were the bulk of it. Until now the engine's AF_UNIX was the
X server's connection and a socketpair was two crossed pipe buffers;
everything else was ENOTSOCK or EAFNOSUPPORT, recvmsg on a socketpair
included, and MSG_PEEK consumed - after which the next recv blocked the
process forever. Local sockets are now one model: a stream socket is an
unconnected handle until connect or accept turn it into the socketpair
shape (two crossed buffers, so read/write/poll/EOF/SIGPIPE are the pipe
code paths), a datagram socket is a queue of messages, and bound names
live in a registry shared by the process tree (`inet:port`, `unix:path`
and abstract names), so a forked or exec'd child can connect to its
parent's listener. connect queues the server's end on the listener's
backlog; accept pops it; a connection nobody has accepted yet counts as
a live reader and writer for the EOF sweeps. bind of a filesystem name
makes a socket node (stat: S_IFSOCK) that unlink removes; the name is
freed when the last descriptor on the bound socket closes, the node
stays and connecting to it is ECONNREFUSED, as on Linux. Ephemeral
ports count up from 40001. SCM_RIGHTS rides with the byte offset of the
message it was sent with: recvmsg stops at the next such boundary and
installs the handles as new descriptors of the receiving process
(MSG_CMSG_CLOEXEC honoured, MSG_CTRUNC when the control buffer is
short). shutdown marks the peer's buffer EOF and the writer EPIPE
(MSG_NOSIGNAL keeps the signal away); getsockopt answers SO_TYPE,
SO_ACCEPTCONN and the buffer sizes; getsockname/getpeername write the
real family and name, or the two-byte unnamed form. AF_INET is loopback
only: a connect to a port nobody listens on is ECONNREFUSED, a UDP send
to one is silently dropped, and nothing reaches the host's network.

The rest, line by line: pidfd_open (an fd that polls readable when the
child is gone; without it the census's later descriptor numbers were
all off by one), waitid (P_ALL/P_PID, WEXITED, WNOHANG, WNOWAIT, the
siginfo with CLD_EXITED/CLD_KILLED), rt_sigqueueinfo carrying si_value
into the handler's siginfo, prctl PR_SET_NAME/PR_GET_NAME per thread
and PR_GET_DUMPABLE, personality (query and set), getgroups,
getpriority/setpriority (glibc's nice() is built on them), times,
preadv/pwritev and their v2 forms, madvise EINVAL on an unaligned start
(before, it rounded down and dropped the neighbouring page - that is
what emptied the mremap probe), lseek EINVAL on a negative result,
access X_OK against the file's mode bits, EBADF from close and fstat of
a closed descriptor, openat ENOTDIR when the directory fd is a file,
O_CREAT|O_EXCL EEXIST, O_CREAT ENOENT when the parent directory does
not exist, readv over a pipe or a connected socket (it was EBADF),
write to a directory fd EBADF (it went to stdout), read of a directory
EISDIR. The O_CREAT parent check found a hole of its own: the engine
knows a directory only as a prefix of provisioned files or a mkdir, so
a guest with nothing under /tmp had no /tmp, and busybox's `echo hi >
/tmp/f` in the shell differential failed; the FHS baseline (/tmp,
/var/tmp, /dev/shm, /run, /root, /home and the rest) is now always
there, like /proc and /dev were. One probe was dropped from the
fixture rather than matched: MAP_FIXED_NOREPLACE at 0x10000 maps
natively and cannot here (the flat window has no such address), a
structural limit already recorded under go build.

Before this batch shipped, the full sweep after batch 12 had found two
regressions the small runs had not: tar-x exited 127 and cargo-build
faulted. One cause: the chown family (chown/fchown/fchownat) shared a
case label with the new chmod handler and read a uid as a path - tar's
fchown after every extracted file killed the child. The sweep is the
check that matters; the small runs cover what the batch touched.

The sweep on the fixed engine then failed java-version, which the
earlier sweep had passed, and the trace showed why: the HotSpot launcher
stats "." and opens ".." while locating itself. With nothing under /tmp
and no chdir, the engine's cwd was unset, and norm() left a relative
name relative - "." normalised to an empty path that the new cwd rule
called a directory, and ".." to a path that did not exist, so the
launcher gave up with exit 1. Relative names at the root are now
absolute ("/name"; "." and ".." are "/"), which is what every other
lookup already assumed. `BREADTH_STRACE_FILE=path` writes a failing
case's whole trace, which is how the two lines were found.
The sweep with census2 in it, on the final engine: 195 of 195 exact in
23.5 minutes.

### Batch 14: the third census, and unmodified CPython over the new sockets

First a check that the socket layer holds up under a real program:
`tools/fixtures/sock.py` on the unmodified CPython runs a TCP echo
server on the loopback with the client in another thread (70 KB
through the pair, select on the client end), an AF_UNIX stream server
on a path, datagrams between two bound names, and a pipe end passed
over a socketpair with `socket.send_fds`. Byte-identical on the first
run; it is the python-sock breadth case. One lesson was the fixture's,
not the engine's: the server thread printed its own lines, and native
schedules the two threads' prints in either order, so the server's
lines are collected and printed after the join.

The third census (`tools/fixtures/census3.c`, 131 lines) covers
filesystem edge cases, /proc shapes, timers and threads: hard link
counts, symlink forms, a symlink loop, a 5000-byte name, rmdir of a
non-empty directory, rename over it, mkdir under a missing parent,
truncate, O_APPEND with pwrite, O_PATH, dup2 onto itself and onto -1,
mkfifo via mknod, umask and chdir in a forked child, F_OFD locks, poll
on a file, a directory and a bad descriptor, epoll edge-triggered and
oneshot with their error paths, a SIGEV_SIGNAL posix timer taken by
sigtimedwait, clock_nanosleep TIMER_ABSTIME and its EINVALs,
sigsuspend, sigwaitinfo, readlink of /proc/self/{cwd,exe,fd/N},
/proc/self/{cmdline,status,stat,maps,limits,mountinfo}, /proc/meminfo,
/proc/cpuinfo, /proc/sys/kernel/{osrelease,pid_max}, uname,
gethostname, sysconf, a pthread's tid, set_tid_address, the sched
family.

The first engine run hung so hard that runbin's guard never fired:
`nanosleep({0, -1})` is EINVAL natively and became a sleep whose
deadline never came (runbin sleeps toward a deadline without counting
it against the guard). With sleep arguments validated (tv_nsec in
range, a known clock id, CLOCK_THREAD_CPUTIME_ID refused) the run went
through and twenty-five lines differed, fixed line by line: ELOOP and
ENAMETOOLONG (a `PathErr` thrown by path resolution - forty hops
through symlinks, or a name over 4095 bytes - and turned into the
errno by the syscall dispatcher, so every path-taking syscall answers
without its own check), readlink's forms (one handler for readlink and
readlinkat: the target, /proc/self/exe, cwd, root, fd/N naming the
descriptor's file or its anonymous kind - `pipe:[ino]`,
`socket:[ino]`, `anon_inode:[eventfd]` - EINVAL for a non-link and
ENOENT for nothing at all; it was EINVAL for everything else), mkdir
ENOENT under a missing parent (it created the directory), truncate(2)
(ENOSYS; open descriptors follow the new buffer), O_APPEND applied to
pwrite as well as write (Linux ignores pwrite's offset on an append
descriptor, and every write lands at the end whatever the position),
O_PATH descriptors that fstat but do not read or write, dup2/dup3
EBADF outside the descriptor range and EINVAL for dup3 onto itself,
poll on a directory readable, epoll: EPOLLET reports a descriptor only
when something arrived since its last report (a generation key from
the pipe's byte counters), EPOLLONESHOT disarms after one report until
MOD re-arms it, DEL of an unregistered descriptor ENOENT, ADD of a
regular file or directory EPERM, ADD of the epoll descriptor itself
EINVAL, and the sched family (getparam/setscheduler/getscheduler,
priority min/max per policy, rr_get_interval) instead of ENOSYS -
glibc's sched_* wrappers had all been failing. One probe was the
fixture's own race: it armed a 2 ms timer and only then blocked
SIGALRM, and on the slower engine the expiry landed on the handler
before the mask went up; the mask now goes up first, which is how the
pattern is meant to be written. The census is a breadth case.
The sweep with census3 and python-sock in it: 198 of 198 exact in 23.4
minutes. (A first attempt stalled in chunk 1 while two other guests of
mine ran beside it; alone, the chunk is 54 of 54 in 4.5 minutes - one
big guest at a time remains the rule.)

**Sockets across processes.** The http-loop case puts python's
http.server (ThreadingHTTPServer: listen, poll, accept, a thread per
request) in the background of a bash script and has curl retry until it
connects, then fetch a 404, then kill and wait - three programs, the
listener's name found through the registry the process tree shares.
Byte-identical, 32 s. Its first attempt "hung" only because it ran
beside the sweep; alone it finished before a 120 s snapshot was due.

**Node over the local sockets.** `tools/fixtures/net.js` on the
unmodified node: a TCP echo server and client in one process (libuv's
nonblocking connect, epoll edge-triggered readiness, 2 MB through the
pair with backpressure), a server that closes first, a refused port,
a UDP exchange, a unix-domain server. Byte-identical on the first run
(35 s); the node-net breadth case. libuv is the consumer the
edge-triggered epoll was built for, and it drove it without a gap.

**A subshell's children go with it.** Both socket cases had a line on
stderr that breadth does not compare: `kill: %1: no such job`. bash runs
`cd d && cmd &` as a subshell that forks cmd and waits for it, and a
forked child that blocks is what the engine materialises into its own
engine (the vfork window ends). The record of cmd, the subshell's
child, stayed in the parent's children list: the materialised subshell
found no children, got ECHILD from its wait, and exited, so its parent
reaped the job before `kill %1` ran (`CHILDTRACE=1` in runbin names
the site that creates each child record, which is how the stray record
was found). Records now carry the process that forked them, wait4 and
waitid answer only for the caller's own children (a subshell used to
be able to reap its parent's), and a window's children move into its
engine when it is materialised. Three-line repros of the shape
(`cd /tmp && sleep 30 & ...; jobs -l; kill %1`) now match native
exactly, stderr included.
The sweep with node-net, http-loop and git-http in it: 202 of 202
exact in 25 minutes.

### Batch 16: the fourth census - System V IPC, message queues, a pty, sessions

`tools/fixtures/census4.c` (112 lines native): System V shared memory
(a segment written by a forked child and read back by the parent),
semaphore sets (SETVAL, a down that would block with IPC_NOWAIT, up,
RMID), message queues (typed receive, the lowest type at or below a
bound, E2BIG and MSG_NOERROR), POSIX message queues (priorities,
EMSGSIZE both ways, unlink), a pty (window size both ends, termios,
raw mode, bytes both ways, TIOCGPGRP on a pty no session owns, a child
that setsids and takes it with TIOCSCTTY), pipe capacity (F_GETPIPE_SZ,
F_SETPIPE_SZ), tee, splice both ways and with zero length, vmsplice,
O_CLOEXEC across an exec (a sh child writes to the inherited
descriptor and fails on the other), sessions and groups (setsid by a
group leader is EPERM, a child's setsid, ESRCH for a foreign pid), the
hardening probes programs feature-test (seccomp, PR_GET_SECCOMP,
no_new_privs, membarrier's command mask, rseq's EINVAL, unshare(0) and
a namespace flag, an unknown prctl option, kcmp), signal flags
(SA_ONSTACK with the handler's stack checked, SA_RESETHAND, SA_NODEFER
with a nested raise, SA_NOCLDWAIT reaping the child before waitpid),
and statx (its mask, AT_EMPTY_PATH on fd 0, a bad flag).

Everything in the first three groups was ENOSYS. System V IPC is now
one registry for the process tree, in the fs metadata every engine
shares: a shared-memory attach is a range of the attaching engine's RAM
holding a copy of the segment, and the copy and the segment are
reconciled at syscall boundaries (a version on the segment: if someone
else wrote, take theirs; otherwise if ours changed, publish it - a
large segment is compared only at attach, detach, exit and fork), which
is enough for the fork-then-read shapes of real users and is what a
flat window can do without page traps. A window child's attaches are
pushed before its journal rolls back; a materialised child inherits
the attaches with the image. Semaphore ops check the whole array
before applying it and block (IPC_NOWAIT: EAGAIN) until a change wakes
the tree; message queues are typed lists with Linux's 8 KB and 16 KB
bounds. POSIX message queues are descriptors over a shared name table,
priority-ordered, with EMSGSIZE, EAGAIN and the timed forms. Each
process now has a group and a session (a record on the engine or on
the window child's proc, inherited at fork, carried to a materialised
or exec'd child): setsid refuses a group leader, setpgid/getpgid/getsid
answer for self and children and ESRCH otherwise, and a pty takes the
caller's session at TIOCSCTTY, so TIOCGPGRP on a pty no session owns is
ENOTTY as on Linux (it answered 1). tee copies a pipe's bytes without
consuming them; vmsplice writes an iov into a pipe; a zero-length
splice or tee returns at once (it waited for data that would never be
asked for - the census's one hang). F_SETPIPE_SZ rounds to a power of
two of pages and the writer's blocking bound follows it. The hardening
probes answer as Linux does: a seccomp filter installs (returning
failure makes sandboxed programs abort), an unknown prctl option is
EINVAL (it was 0), rseq rejects bad arguments, unshare grants the
flags that need no namespace and refuses the rest with EPERM. SA_NOCLDWAIT
is remembered even though a SIG_DFL disposition stores no action, and
wait4 then reaps and answers ECHILD. statx was ENOSYS with glibc
falling back to fstatat, which lost its argument checks; it now
validates its flags and produces the statx layout from the fstatat
answer. The census is a breadth case; the engine differentials and
the session-sensitive breadth cases (dash, busybox, bash traps and
process substitution, timeout, xargs, make, python and perl and ruby
children) stayed exact.
The sweep with census4 in it: 204 of 204 exact in 25.7 minutes.

### Batch 17: the fifth census - job control and the line discipline

`tools/fixtures/census5.c` (77 lines native): a child stopped with
SIGSTOP and seen through waitpid(WUNTRACED), continued and seen through
WCONTINUED, stopped again with SIGTSTP, sent SIGTERM while stopped (it
must wait for the continue, then die of it), a child that ignores
SIGTSTP and does not stop; a pty opened the posix way (grantpt,
unlockpt, TIOCGPTLCK, TIOCGPTN, ptsname, ttyname), the default termios
flags and control characters, canonical editing with the exact bytes
the master sees echoed (erase as "\b \b", kill, a newline as "\r\n", CR
turned into NL and echoed as "\r\n"), a partial line invisible to
FIONREAD and poll, ^D mid-line delivering the partial line and ^D at
line start as one EOF after which the line keeps working, ONLCR on the
slave's output, TIOCOUTQ, TCFLSH, tcdrain, tcsendbreak, raw mode with
VMIN=2 (poll not ready after one byte, read waits for two, no echo, no
ONLCR), /dev/tty with no controlling terminal (ENXIO), ^C typed on the
master reaching a child that took the pty as its controlling terminal
(and its "^C" echo), TIOCNOTTY, and the pty after its session leader
exited (TIOCGPGRP and TIOCGSID both ENOTTY).

Stop signals had been "not modelled" (discarded) since the first
signal work, and the whole first section hung at the first waitpid.
A child engine can now stop: SIGSTOP always, SIGTSTP/SIGTTIN/SIGTTOU
when neither caught nor ignored; its parent's pump skips it, raises
SIGCHLD with CLD_STOPPED, and wait4/waitid report WIFSTOPPED once per
stop and WIFCONTINUED once per SIGCONT (which resumes it whatever its
disposition). A fatal signal that arrives while stopped stays pending
and is acted on after the continue, as on Linux. The line discipline
gained what the census listed: echo goes through output processing (an
echoed newline is "\r\n" under OPOST|ONLCR - the engine's own pty test
had encoded the old plain "\n" and was corrected against the native
bytes), ISIG turns VINTR/VQUIT/VSUSP into SIGINT/SIGQUIT/SIGTSTP for the
pty's foreground group across the process tree with the "^C" echo,
VEOF mid-line flushes the partial line and at line start queues a
one-shot EOF marker (it was a sticky end-of-file), raw mode gates reads
and readiness on VMIN, TCFLSH really flushes, and the queue sizes are
kept so FIONREAD answers. Each session records its controlling
terminal: /dev/tty opens it (a slave handle on that pty), or the host
terminal in terminal mode, or ENXIO; TIOCNOTTY gives it up; and when a
session leader exits its pty loses its session and foreground group.
Both ends of a pty stat as character devices with matching numbers by
path and by descriptor, which is what ttyname() checks. The census is
a breadth case.

Two things the sweep taught after the batch landed. The host loop takes
the earliest deadline across the process tree so a runnable child never
waits out its parent's tick, and it counted a stopped child as runnable:
a parent sleeping while its child was stopped re-ran its nanosleep
without ever napping, and runbin's guard called it a hang. A stopped
child now sets no deadline. And the fixture itself had two races that
Linux, not the engine, exposed under the sweep's load: a blocking
waitpid for a state the kernel never reported stalled the whole sweep
(the native run, so no wall cap applied), and a SIGTSTP sent on the
heels of a SIGCONT sometimes did not stop the child at all. The waits
now poll with WNOHANG under alarm(60), and the SIGTSTP probe gets a
fresh child - a census must fail loudly, never hang, and must not ask
the kernel a question with two answers.
The sweep with census5 in it, chunks 1-3 from the first run and 4-5
rerun on the final engine and fixtures: 206 of 206 exact. The one
native failure along the way was the orphaned-group rule: Linux
discards SIGTSTP sent to a member of an orphaned process group, and a
harness run under nohup is one, so the fixture now takes its own group
under its live parent - the engine stops the child either way, which
is the difference a native comparison exists to show.

### Batch 18: an interactive bash on a pty

With job control in the engine, the consumer that exercises all of it
at once is a shell on a terminal. `tools/fixtures/ptysh.c` opens a
pty, forks `bash --norc --noprofile -i` with the slave as its
controlling terminal (TERM=dumb, PS1='$ '), and types like a person:
`echo hello`, `sleep 30 &`, `jobs`, `kill %1`, `echo after` (the job's
death is reported before that prompt), `cat` with a line typed and ^C,
`sleep 100` with ^Z, `jobs`, `fg` with ^C, `echo $?`, `exit`. It
prints what the terminal showed after each step, escaped, with job
pids normalised, and the native transcript is stable run to run. The
bash-pty breadth case compares it byte for byte.

The first run matched through `jobs` and hung at `kill %1`. Three
engine gaps, each a real one: kill(2) only knew a direct child by pid,
so bash's `kill(-pgid)` for `%1` fell through to signalling the shell
itself (kill now finds any process in the tree by pid, and pid 0, -1
and -pgid reach the caller's group, everyone, or a group across the
tree); a tail-exec'd image (a forked job child that blocked before its
exec and was materialised, then exec'd sleep in place) swallowed every
signal sent to it, so ^Z to the foreground group stopped the sleep
engine but the shell's wait4 - which watches the image - never saw a
stop (the image now forwards signals to its replacement and mirrors
its stopped / continued state); and the image adopted only the
replacement's exit code, not its signal, so a job killed by SIGTERM
was "Exit 143" rather than "Terminated" and bash did not print the
newline it prints after a job dies of ^C (the signal is carried
through). Also, stop signals had stayed default-ignored in the
disposition table from before batch 17 - only the root, which has
nobody to continue it, keeps that. After those the whole transcript is
identical, 10.6 s; the engine differentials and the shell- and
signal-sensitive breadth cases stayed exact.
The sweep with bash-pty in it: 208 of 208 exact in 27.7 minutes.

### Batch 19: script(1) and vim on a pty

Two more terminal programs, now that a session on a pty works. `script
-q -c 'echo hi; printf "a\tb\n"' /dev/null` produced the right bytes
on the first run and then never exited: script takes SIGCHLD through
a signalfd, with the signal blocked and its disposition SIG_DFL, and
the engine discarded a default-ignored signal at generation - so the
child's exit never reached the signalfd and script polled forever.
Linux queues any blocked signal whatever its disposition ("blocked
signals are never ignored, since the handler may change by the time it
is unblocked"), and so does the engine now: the discard applies only
when the thread the signal lands on does not block it. `vim -u NONE -i
NONE` on a pty (TERM=vt100, 24x80: open a file, `jo`, a line, Esc,
`:wq`) matched byte for byte once the terminfo tree was provisioned -
without it vim printed E557 and fell back to its builtin terminals,
which a real deployment would see too, so the case provisions
/usr/share/terminfo. Both are breadth cases (script-pty, vim-pty).
The sweep with script-pty and vim-pty in it: 210 of 210 exact in 25.9
minutes.

### Batch 20: node splitting - m4's hottest functions leave the dispatch layout

Back to translated-code quality (#26), starting from where m4 spends
its time. The profile of the big m4 run puts next_token (0x40fe70) at
16% self time, then 0x410bf0 (8.5%), next_char (0x409e80, 6.8%),
0x411248 (5.2%) and 0x417160. Four of those six were emitted in the
br_table dispatch layout: `structure()` reported "block/loop overlap"
for each, and dumping their CFGs showed why. gcc's tail duplication
leaves the tokenizer's loop with two entry blocks (54 and 81 in RPO,
entered from before the loop and from inside it), 0x410bf0's expand
loop with seven, 0x411248's with four. These are genuinely irreducible
loops - no block order can nest them - which is what task #62 had
found and priced without fixing.

**Node splitting** fixes them at the CFG level, before the unroller:
for a strongly connected component with several entries, pick the
header whose alternative is cheapest, copy the members reachable from
the OTHER entries without passing that header, and point the entering
edges at the copies. Copies are the same block objects (same
instructions, same address; the unroller already relies on that), their
internal edges stay inside the copy, every other edge goes to the
original, so the copied path enters the loop only through the header.
Nested loops are found by removing the header and repeating inside;
the pass iterates to a fixpoint (a copy can hold an irreducible
sub-loop of its own) under a per-function cap of half the function's
blocks (at least 48, at most 512), then the layout is recomputed - RPO
plus the loop compaction, now a function shared with the first layout.
A jump-table site whose case block was duplicated carries a per-site
remap from the resolver's representative index to its copy, applied to
its br_table (structured) or `$pc` (dispatch): 0x410bf0 is entered by
the same switch twice, once before the loop and once inside it, at two
different case blocks, and without the remap it stayed in dispatch. A
representative the layout drops (an original left unreachable once
every entering edge went to a copy) is replaced by a reachable copy
and the remaps are re-keyed. OXWASM_NODESPLIT=0 disables; the
dispatch layout remains the fallback past the cap.

All four hot m4 functions take the structured layout now (next_token
181 -> 213 blocks, 0x410bf0 347 -> 407, 0x411248 117 -> 140, 0x417160
518 -> 732); the m4 unit's dispatch count went from 98 functions to
47. m4 steady state 7.18x -> 6.78x on the vsnative harness (engine
9,822 ms against native 1,449, from 10,248 against 1,427 before the
batch; the session-to-session noise on the engine number is about
+/-10%, and the interleaved off/on pair read 7.35x -> 6.95x); the
translation cost is 2,726 duplicated blocks on the small run, 5.2 ->
5.6 s of wall. disptest now compiles its irreducible
function in both layouts (splitting off forces dispatch, on must
structure it) and checks both bit-exact: 800/800.

**Hot-site un-prune, measured and left off.** With the layout fixed,
next_token's remaining cost is its per-character call to next_char
through the $ftr chain - the callee tiered up first, in its own unit,
so every later caller's closure pruned it. Keeping it in by hand
(OXWASM_UNPRUNE=409e80) took m4 from 6.95x to 6.47x. The general rule
(a callee called from a cycle of the unit's root stays in the closure
when it is at most 640 instructions, under a per-unit budget) is in
the translator as OXWASM_UNPRUNE_HOT=N, but its default is 0: it kept
567 callees (67k instructions) per m4 run at a 1024 budget, +2 s of
analysis and emit for 4.5% of steady state (9582 -> 9146 ms) - a net
loss below a minute of runtime. The version that pays needs a call
counter on the chained-call path so only callees that are actually
called hot are re-homed (a re-tier), which the current profile cannot
tell (it stops counting at the first tier-up).
Gate: full suite green (disptest in both layouts, jtabtest 112/112),
sweep 210 of 210 exact in 31.2 minutes (25.9 before; the compiler
cases pay the duplicated blocks' emit).

The same A/B on the other call-dense case: perl's 30M-iteration loop
went 7.26x -> 6.24x (engine 5,645 -> 5,245 ms, native 777 vs 840 ms
across the pair) - its runloop is a switch inside a loop that the
switch also re-enters, the shape the jump-table remap exists for.
vim -es (`%s` over 400 k lines): 4.42x -> 3.58x (engine 1,504 ->
1,178 ms, native 341/329 ms). Three call-dense binaries, three
double-digit steady-state gains from one structural fix - the
dispatch layout had been the widest remaining tax on gcc-shaped hot
loops.

| binary | before | after |
|---|---:|---:|
| m4 | 7.18x | 6.78x |
| perl | 7.26x | 6.24x |
| vim -es | 4.42x | 3.58x |

### Batch 21: deferred units that never registered, and a lost unroll copy

Profiling perl under runbin (the diagnostic harness) instead of the
bench runner gave a run of 287 s where the bench measured 9 s - same
engine, same binary, same script. The bench runner assembles
synchronously; runbin, breadth and every default host assemble
through the deferred broker, and under the broker perl's op
dispatcher ran its whole loop interpreted. The trace (ASMTRACE=1,
new lever) showed why: its unit was submitted at t=9 s, came back
moments later, and registered at t=38 s - the end of the run.
`pumpAsm()`, which collects finished units from the broker's fifo,
ran only at `run()` entry and at the start of the next tier-up. Once
every hot root had been submitted nothing tiered up any more, the host
slice (5e7 steps) did not end, and the finished units sat in the fifo
while the interpreter did the work their translations were for. The
interpreter loops now pump every 2^18 steps while anything is in
flight (top-level `_run1` and the callout `interpUntil`, both guarded
on `_inflight.size` so a quiet engine pays a field read). perl small:
38 s -> 11 s under deferred assembly, the same as synchronous.

The regression test (`engine/diff/pumptest.mjs`, in the suite) holds
every unit until pumped, runs a 3M-iteration call loop in one host
slice and checks that the loop went compiled (interpreted steps under
4 per iteration; 18M before the fix). Writing it found a second bug:
the loop-head unit of its loop failed to emit with "Cannot read
properties of undefined (reading 'push')" - the unroller appends its
copies when the block walk reaches the range's end index e, and a
unit rooted at a loop head whose exit block lays out BEFORE the loop
has e === N, so the copies were never appended while every edge had
already been remapped onto them. Pre-existing (reproduced on the
pre-batch-20 translator); the copies are appended after the walk in
that case.
Gate: suite green (pumptest in it), sweep 210 of 210 exact in 30.1
minutes (31.2 before the pump; the cases that stall interpreted with a
unit in the fifo are the long-lived-frame ones, and most breadth cases
are short).

**perl under the structured layout, profiled properly.** With deferred
units registering, runbin's perl profile is the bench's: the 30M-op
loop is ~5.2 s of a 12.4 s run, the runloop's loop-head unit
(`f_531718`, Perl_runops_standard's `call *0x10(%rax)` loop, 4 blocks)
is 10.5% of all samples on its own and the pp_ callees (0x569780
pp_modulo 5.2%, 0x53f0a0 4.7%, pp_multiply/add/padsv 2-4% each) the
rest. The runloop unit is as tight as the protocol allows: probe,
call_indirect, the accounting words, four reloads. One suspect for the
callee side was V8's own entry cost for functions with many locals
(pp_modulo declares 51, nine of them v128): a kernel calling a leaf
30M times through call_indirect reads 1.33 ns/call with 1 local,
1.34 with 40 i64, 1.33 with 40 i64 + 9 v128, 1.36 with 60 + 16 - the
local count is free under TurboFan (SSA drops the zero-init), so
pruning declarations (3 of 51 are unused anyway) is not a lever.

**vim -es, same method (3x input, 66 MB).** No hot spot to attack: the
top compiled units are 3.7%, 3.6%, 3.1%, 2.6% of samples (a libc
routine, then vim's 0x511610, 0x4e6337, 0x6e7f5e), the rest a long
tail. vim's 3.58x is spread over its regexp engine and buffer code,
which makes it a whole-translator quality question rather than a
per-function one; the two structural levers that applied broadly
(node splitting, the pump) are in. Parked; the next lever for the
call-dense band is the callee's own entry/exit (reloads and spills
around a direct in-unit call), priced next.

### Batch 22: a vfork left its parent interpreted for life

The slowest breadth cases by engine time were python-mp (161 s),
rustc-asm, cargo-build, java-jit, java-hello, gdb-batch - and
vforkexec at 30.7 s for a fixture whose whole work is two 4M-iteration
loops around one vfork+exec. Its loop-head unit registered at t=4.9 s
(the pump is fine) and was never entered: the top-level dispatch
decision at the head read `f=function` but `aotBudget=-1033929`. The
vfork window sets `aotBudget = 0` while the child thread runs (the
child interprets so its stores go through the journal) and saves the
parent's value to restore on the way back - but the parent's value is
normally UNDEFINED (no budget: dispatch freely), and the restore was
gated on `saved !== undefined`, so it never fired: every parent of a
vfork came back with the budget at 0 and `--aotBudget < 0` vetoed
every top-level AOT dispatch for the rest of its life (chained calls
inside compiled frames still ran, entries from the interpreter did
not). gcc's driver, every shell that spawns, make, cargo, the
multiprocessing pool - all paid it after their first vfork. A flag now
records whether a save happened; vforkexec 46 s -> 4 s under runbin.
The DBGRIP=hex (dispatch decision at a rip) and DBGBUDGET=1 (who sets
the budget, with a stack) levers in runbin found it.

**The livelock the budget bug had been hiding.** With parents
dispatching compiled code again, the first sweep stalled on python-mp
(35 minutes with no output; 161 s before). A CPU profile taken from
outside through the inspector port (`scratchpad/insprof.mjs`; the
in-loop levers cannot fire when the engine never leaves a slice)
showed one `dispatchAot` that never returned, and a pause-and-evaluate
client (`inspeval.mjs`, `globalThis.__eng` from runbin) read the
state: the Pool's three handler threads spinning through poll, wait4
and clock_gettime (2.2M calls), both workers materialised as child
engines blocked on their pipes. Children are pumped between run()
slices, a slice ends on a step budget, and compiled code burns no
steps - so the parent never blocked as a whole and the workers never
ran. Interpreted, the same parent ended its slice every 5e7 steps.
The engine now cuts a slice older than 50 ms at the next compiled
syscall, callout hop or 4096 nested interpreter steps whenever a live
child engine exists (`_kidsDue`): an immediate-deadline block unwinds
to the host, which pumps the children and resumes at the next
instruction. python-mp 161 s -> 79 s under runbin.
Gate: suite green, sweep 210 of 210 exact in 33 minutes; python-mp
161 s -> 41 s in the sweep. The compiler and JVM cases read ~30%
slower than the previous sweep, but an interleaved A/B of java-hello
on the pre-fix and post-fix engine gave 106.8 s against 107.9 s - the
box is slower this hour, the fixes are not.

### Batch 23: what node splitting costs a compiler run

The rustc-asm case profiled: 189 s, of which the garbage collector
is 44 s (the translator's text churn: 790 MB of wat over 5,500
units), emit 19 s, analysis 10.5 s, the instruction walk 10.4 s, V8
compiling units 13 s - and 15 s in the node-splitting pass from
batch 20: `walk` (the nested SCC descent) 8.4 s, `layoutOrder`,
`findIrreducible`, `go`. Three things were wrong with it at compiler
scale. It ran on every function: the layout pass now answers
reducibility for free (a retreating edge u->h is a back edge iff h
dominates u, iff the entry is not in the "reaches u without passing
h" set the loop compaction already computes), and the split runs only
on the witness - 1,367 of rustc's 11,000 analysed functions, so this
alone changed nothing. It chose headers by walking the component once
per candidate entry, quadratic on the tangled components LLVM's jump
threading leaves (dozens of entries): more than 12 entries is now
hopeless outright, and each candidate's walk stops at the cap. And a
function that ran past the cap kept its partial copies in the CFG
(emitted, never structured): they are discarded. `walk` 8.3 s -> 1.0
s; rustc's split attempts read capped N quartiles [62, 562, 1006,
1618, 4895] against successful N [3, 81, 217, 546, 3665] and
duplicated blocks [1, 2, 9, 33, 512] - the cap is refusing the right
things. m4's four hot functions still structure, output exact.
Gate: suite green, sweep 210 of 210 exact in 32.3 minutes; rustc-asm
166 s -> 144 s on the same (slow-hour) box, total engine time 1,911 ->
1,873 s.

**The scavenger.** The largest single line in the rustc-asm profile
was never the translator's own code: the garbage collector, 44 s of
181, all of it scavenges of the short-lived strings and instruction
objects the translator makes (790 MB of wat text, an object with
BigInt fields per analysed instruction). Node's default semi-space is
16 MB. `--max-semi-space-size=64` reads 17 s of GC and 154 s of wall,
128 MB reads 11 s and 151 s; `v8.setFlagsFromString` after startup
measured no change (43.6 s), the flag has to be on the command line.
`tools/v8flags.mjs` re-executes a node host once with the flag and its
own execArgv (`--expose-gc`, `--cpu-prof`) kept; breadth, the bench
runner and runbin call it at their top, OXWASM_NO_REEXEC=1 opts out.
The browser page is V8's own heuristics and is untouched by this.
Gate: sweep 210 of 210 exact in 28.9 minutes (32.3 before the flag,
same box); rustc-asm 144 s -> 121 s, cargo-build 145 s -> 120 s,
total engine time 1,873 -> 1,667 s.

**Two more translator lines.** `structure()` fixed improper scope
overlaps with an all-pairs loop repeated to a fixpoint - quadratic in
the scope count, 6 s of the rustc run. Each pass now visits the scopes
sorted by begin and a scope meets only the later-beginning scopes that
start inside it; the rules are monotone (begins move back, ends move
forward, never the reverse), so the fixpoint is the same in any
visiting order and so is the overlap no rule can fix (a block ending
inside a loop entered from before its header: once true, it stays true
as intervals only widen). It left the profile's top twenty (under 1.3
s). The instruction walk's visited set was keyed by the address as a
string: a Set of strings or BigInts inserts at ~600 ns, a Set of
numbers at ~165 ns, and a guest address fits 2^53 - keyed by Number
now (the instruction map's string keys, which everything downstream
uses, are unchanged).
Gate: suite green, sweep 210 of 210 exact (31.7 minutes against 28.9
the run before - the box, not the change: java-hello, which the
translator changes do not touch, moved 100 -> 102 s and cargo-build
120 -> 153 s in the same run; the profile, where structure() left the
top twenty, is the evidence).

### Batch 25: the shipped page on the batch 20-24 engine

The node sweep cannot see a browser-only failure, and batches 20-24
changed the emitter (node splitting, jump-table remaps), the tiering
(deferred units pumped mid-stretch, the vfork budget, child-aware
slices) and the hosts. The shipped GIMP page re-shelled on the current
engine modules (`tools/gui/reshell.mjs`, 10 modules, its own units)
in headless Chromium: File > New > OK in 14 s, three strokes, ink 0 ->
2,583 pixels, warm stroke 20.1 ms median input-to-paint (19.8 ms when
the page shipped). The units recompiled by the current emitter
(`repackunits.mjs`, every container entry re-run through
compileUnitWat from the snapshot memory) are the fuller check, below.
Recompiled: 5,753 of 7,810 units re-emitted (1,897 keep their old
bytes - trampolines and units whose analysis the current emitter
refuses - and 160 would lose exports), container 86.4 -> 87.3 MB raw.
Re-shelled with them, `pagecheck.mjs`: File > New > OK, strokes drew,
20.5 ms median input-to-paint; shipped into demo/gimp (index.html and
app.units.gz), where the check reads 19.2 ms. The page now carries the
engine of batches 20-24 - for the browser the vfork budget fix matters
most: GIMP launches every plug-in by fork+exec, and until it the main
process came back from the first one never again dispatching compiled
code from the interpreter.

### Batch 26: three silent skips on a machine that had never run this

Moved to a fresh machine, the engine ran every breadth case correctly and
the sweep went green - with the AOT tier dead. `wat2wasm` was not
installed, so every emitted unit came back `wat2wasm failed (127): not
found`; the engine counts an assembly failure as one more refused
translation, blacklists the entry and interprets it. Nothing is wrong with
that behaviour per unit, and applied to all of them it produces a run that
is correct and many times slower, with no error anywhere. The only tell was
the counter added at the end of batch 25: `aot=0` on all 25 cases the first
sweep reached, against 300-500 on a small coreutils case with the
assembler present. `curl-file` is the size of the difference on this box:
11.7 s -> 3.6 s, 67 compiled functions -> 545, 8.1M interpreted steps ->
483k.

`makeAssembler` now assembles a one-instruction module with the run's own
flags before the translator emits anything, so a missing wabt - or one too
old for `--enable-tail-call` - is an error at startup instead of a tier-down
nobody sees.

Two more of the same shape came out of the same move.

**The suite could not build its own fixtures.** `realcode.mjs` incbin'd
`/tmp/fib-O1.bin` and five siblings that nothing in the tree produced: they
were whatever a developer had left in /tmp. On a fresh machine the suite
died there - immediately after the 316 hardware cases passed, which made it
read as a hardware failure rather than a missing file - and CI had been red
on that line on every run for days (at least since 2026-09-04), through
every batch of work in that window. The three
functions live in `diff/realsrc` now and are compiled at -O1 and -O2 on
every run. Each is one function with no relocations in `.text`, so its
`.text` section is the callable blob, and whatever the local gcc emits is a
valid case: the test compares it against the CPU, not against a recorded
byte sequence.

**A guard that promised to skip, and crashed instead.** `attest` and
`shelltest` say in their own comments that they use a static busybox when
the host has one and skip otherwise. The guard read the ELF class and
machine words - which a *dynamic* busybox satisfies. Ubuntu ships one in
the `busybox` package (`busybox-static` is the other), and against it the
engine threw `interpreter not provided in files` and took the suite down.
Both now check for a PT_INTERP header and skip when it is there.

**Four cases that passed by comparing two identical failures.** The sweep's
`git-log`, `git-status`, `find-exec` and `ls-l` all read `/tmp/breadth_repo`,
and nothing in the tree built it either - it was a directory someone had made
once. On a machine without it `git -C /tmp/breadth_repo log` fails the same
way natively and under the engine, so the byte compare matched two error
messages and four cases counted green while testing nothing. `git-http`,
which clones that repo over HTTP, is the only one that failed, and it failed
on `cd: /tmp/bgit: No such file or directory` - three steps downstream of the
cause. The harness builds the repo now, with pinned dates, names and content;
the five cases produce real output (git-log 47 B of hash and subject where it
used to produce zero). The sweep's summary also names any case it SKIPPED and
how many of the list that is, because a skipped case leaves the ratio at N/N.

The common shape is worth naming: each of these is a dependency on the
host that the tree stated nowhere and checked nowhere, and each failed in a
way that looked like something else - a slow engine, a hardware divergence, a
missing loader, a broken clone. Two of them did not look like failures at
all. The project README now lists the host tools a node run needs and what
each one's absence does.

Gate on the new machine: the verification suite green end to end (316
hardware cases, the six real-gcc blobs, every differential); the breadth
sweep 168 of 169 exact with the AOT tier live, the one failure being
`git-http` on the missing repo above and one case skipped because its
fixture was deleted out from under the run. All six of those cases pass on
re-run with the fixtures built, and a confirming full sweep follows.
