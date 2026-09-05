# Native reference execution for the CPython refcount bug (#35).
#
# The engine records eight writes to _pyio.IOBase.__doc__'s refcount and the
# object ends up freed while IOBase.__dict__ still points at it. What is not
# known is WHICH write is wrong. This runs the same binary natively under gdb
# and logs the same sequence, so the two can be diffed.
#
# Addresses transfer directly: python3 is ET_EXEC, so its text is at the same
# addresses under gdb as in the guest. The OBJECT address will differ, which
# is why the object is identified by what it is - a 1,235-char str whose
# payload begins "The abstract" - rather than by where it lives.
#
# The creation site cannot be used for identification: there the header is
# still the previous occupant's bytes. PyDict_SetItem+0x32 is the first point
# at which the object reads as itself.
#
#   gdb -q -batch -x tools/pyref.gdb.py --args /usr/bin/python3 -S -c "print(6*7)"
import gdb

SETITEM = 0x51f342          # PyDict_SetItem+0x32: addq $0x1,(%rdx)
TARGET_LEN = 1235
MAX_STOPS = 40

gdb.execute("set confirm off")
gdb.execute("set pagination off")
gdb.execute("set height 0")

def u64(addr):
    return int(gdb.parse_and_eval(f"*(unsigned long*)0x{addr:x}"))

def payload(addr, n=16):
    out = ""
    for i in range(n):
        try: c = int(gdb.parse_and_eval(f"*(unsigned char*)0x{addr+0x28+i:x}"))
        except gdb.error: break
        out += chr(c) if 32 <= c < 127 else "."
    return out

# Two passes. Pass 1 finds WHERE the object lives by conditioning on what it
# is; pass 2 (OBJ=<addr> in the environment) starts from the creation site at
# that address, so the log covers the object's whole life instead of starting
# mid-way. gdb disables ASLR, so the address from pass 1 is stable.
import os
KNOWN = os.environ.get('OBJ')
CREATE = 0x516060           # PyUnicode_FromString+0x130: movq $0x1,(%r15)

if KNOWN:
    bp = gdb.Breakpoint(f"*0x{CREATE:x}")
    bp.condition = f"$r15 == {int(KNOWN, 0)}"
else:
    bp = gdb.Breakpoint(f"*0x{SETITEM:x}")
    # rdx is the object being increfed; +0x10 is the PyASCIIObject length
    bp.condition = f"*(long*)($rdx+0x10) == {TARGET_LEN}"
bp.silent = True

# COUNT=1: how many DISTINCT objects match the identity condition? If more
# than one 1,235-char "The abstract" string exists, "the object" is ambiguous
# and a native/engine sequence diff could be comparing two different strings.
if os.environ.get('COUNT'):
    seen = {}
    gdb.execute("run")
    for _ in range(30):
        try: o = int(gdb.parse_and_eval("$rdx"))
        except gdb.error: break
        if o not in seen:
            seen[o] = payload(o)
            print(f"REF: match #{len(seen)} at 0x{o:x}  payload={seen[o]!r}")
        out = gdb.execute("continue", to_string=True)
        if "exited" in out: break
    print(f"REF: {len(seen)} distinct objects matched")
    raise SystemExit(0)

gdb.execute("run")

try:
    obj = int(gdb.parse_and_eval("$r15" if KNOWN else "$rdx"))
except gdb.error:
    print("REF: never reached the conditional breakpoint - the object is not "
          "created on this path, or the condition is wrong")
    raise SystemExit(0)

print(f"REF: object at 0x{obj:x}  len={u64(obj+0x10)}  payload={payload(obj)!r}")
print(f"REF: refcount now {u64(obj)}")
bp.delete()

# Hardware watchpoint on the refcount word. Only a handful of writes are
# expected, so this costs nothing.
gdb.execute(f"watch *(unsigned long*)0x{obj:x}")
seq = []
for _ in range(MAX_STOPS):
    try:
        out = gdb.execute("continue", to_string=True)
    except gdb.error as e:
        print(f"REF: stopped: {e}")
        break
    if "exited" in out or "Inferior" in out and "exited" in out:
        print("REF: process exited")
        break
    try:
        pc = int(gdb.parse_and_eval("$pc"))
        val = u64(obj)
    except gdb.error:
        break
    # $pc after a watchpoint trap is the instruction AFTER the store, which is
    # exactly what the engine's watch log records too - so the two are directly
    # comparable without an off-by-one adjustment.
    seq.append((pc, val))
    print(f"REF:   refcnt <- {val:<4} at pc 0x{pc:x}")
    if val == 0:
        print("REF:   *** reached zero natively too ***")
        break

print(f"REF: {len(seq)} refcount writes observed")
