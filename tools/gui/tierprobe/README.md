# tierprobe: which V8 tier runs a once-entered long loop, in the real browser

The engine dispatches a unit a handful of times and each entry can loop for
millions of iterations. `idealmem.mjs` showed node 22 keeps that shape in
Liftoff at ~2.7x TurboFan. This probe answers the question for the product
platform.

    node gen.mjs                 # emits faithful.wasm (the emitter-shaped loop)
    node ../serve.mjs . 8399     # serve with the application/wasm type
    node drive.mjs               # cold visit + reload in one Chromium profile

Measured (Chromium, this container):

    cold  : compile 10.7ms  runs [70.2, 14.6, 16.6, 16.3, 14.5, 14.7]
    reload: compile  4.5ms  runs [15.8, 14.4, 14.5, 16.9, 16.9, 17.9]

Three findings.

1. **Chrome tiers a wasm function up after ONE call.** Call 1 runs the 30M
   iterations in Liftoff (~3.5x); calls 2+ are top-tier. No OSR rescues the
   first call mid-loop - in Chrome or node.
2. **The repeat visit starts top-tier from call 1**: same-URL
   `compileStreaming` hits Chrome's implicit code cache. This is the
   shippable lever for tier occupancy - but it requires STREAMED same-URL
   compiles. The page today compiles units from bytes out of app.units.gz,
   and buffer compiles get no implicit cache.
3. The kernels harness's `mem` 4.1x is the pathological shape: k_mem is
   called ONCE per process, so its only call is the Liftoff one. Real
   programs call their hot functions repeatedly and get top-tier code from
   the second call on; their exposure is one Liftoff pass per function, not
   a permanent multiple.
