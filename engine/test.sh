#!/bin/sh
# Build the oracle and run the whole M3 verification suite.
set -e
cd "$(dirname "$0")/diff"
cc -O2 -o stepper stepper.c 2>/dev/null
node cases.mjs "${1:-300}"
node realcode.mjs
node jittest.mjs
node looptest.mjs
node bench.mjs
node bench2.mjs
node memtest.mjs
node membench.mjs
node simdtest.mjs
node simdbench.mjs
node multest.mjs
node disptest.mjs
node pushmemtest.mjs
node callmemtest.mjs
node xflagtest.mjs
node addflagtest.mjs
node adctest.mjs
node enginetest.mjs
