#!/usr/bin/env python3
"""coldset.py profile.json cold.txt: turn an OXWASM_BLKTRACE profile into an OXWASM_COLD_FILE.

A block is cold when it was translated, never entered, and no executed block's range covers its start (a start that is a
block leader in one unit can be the middle of an executed block in another). Usage:
  OXWASM_BLKTRACE=1 OXWASM_BLKTRACE_FILE=profile.json <run the workload on a fresh unit-cache key>
  tools/coldset.py profile.json cold.txt
  OXWASM_COLD_FILE=cold.txt <run with a fresh key>
"""
import json, bisect, itertools, sys
d = json.load(open(sys.argv[1])); seen = {s: e for s, e in d['seen']}; cnt = {a: n for a, n in d['cnt']}
ex = sorted((s, e) for s, e in seen.items() if cnt.get(s, 0) > 0); starts = [s for s, e in ex]
pm = list(itertools.accumulate((e for s, e in ex), max))
cov = lambda x: (lambda i: i >= 0 and pm[i] > x)(bisect.bisect_right(starts, x) - 1)
cold = sorted(s for s in seen if cnt.get(s, 0) == 0 and not cov(s))
open(sys.argv[2], 'w').write('\n'.join(map(str, cold)) + '\n')
print(f'{len(seen)} blocks translated, {len(ex)} entered, {len(cold)} cold ({100 * len(cold) / max(1, len(seen)):.1f}%)')
