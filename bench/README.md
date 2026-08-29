# oxwasm benchmarks

## pybench.py — CPython-in-the-engine vs native

The same unmodified `python2.7` binary from the GIMP sysroot, run natively
(via the sysroot's own ld.so) and inside the engine:

    # native
    $SYSROOT/lib/x86_64-linux-gnu/ld-2.27.so --library-path \
      $SYSROOT/lib/x86_64-linux-gnu:$SYSROOT/usr/lib/x86_64-linux-gnu \
      $SYSROOT/usr/bin/python2.7 -E -S bench/pybench.py

    # engine (copy pybench.py to $SYSROOT/tmp first)
    node tools/gui/guishot.mjs $SYSROOT /usr/bin/python2.7 /tmp/out.ppm 640x480 100000 -E -S /tmp/pybench.py

2026-08-29 baseline (identical outputs, so correctness holds):

| test     | native | engine  | ratio |
|----------|--------|---------|-------|
| loop3M   | 106ms  | 23881ms | 225x  |
| dict300k | 40ms   | 6945ms  | 174x  |
| str200k  | 34ms   | 11263ms | 331x  |

Diagnosis: 42.7M deopt-chain hops, all landing at CPython's bytecode
handler entries — computed-goto dispatch pays a JS-boundary hop per
Python bytecode (67M chained unit runs vs only 14M interpreted steps;
the translated code itself is not the bottleneck). The planned fix is
in-unit jump tables: trace the table load feeding `jmp *reg`, read the
static table at translation time, and emit an in-wasm br_table over the
targets that fall inside the unit, deopt for the rest.
