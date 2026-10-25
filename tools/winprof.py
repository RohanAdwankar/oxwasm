import sys, bisect, collections, re
# winprof.py <v8log> <dbgfile> <fromRound> <toRound> [node.syms] [libc.syms]
# window = pn of "round (from-1):" .. pn of "round to:" (pn = performance.now() ms, same clock as V8 ticks up to a few ms)
log, dbg, fr_r, to_r = sys.argv[1:5]; fr_r = int(fr_r); to_r = int(to_r)
nodesyms = sys.argv[5] if len(sys.argv) > 5 else None; libcsyms = sys.argv[6] if len(sys.argv) > 6 else None
pn = {}
for l in open(dbg, errors='replace'):
    m = re.search(r'pn=(\d+) txt="round (\d+):', l)
    if m: pn[int(m.group(2))] = int(m.group(1))
fr = pn[fr_r - 1] * 1000; to = pn[to_r] * 1000
starts = []; ends = []; names = []; cts = []; ticks = []; libs = []
for l in open(log, errors='replace'):
    try:
      if l.startswith('code-creation,'):
        p = l.rstrip('\n').split(','); s = int(p[4], 16); e = s + int(p[5]); t = int(p[3]); starts.append(s); ends.append(e); names.append(p[6]); cts.append(t)
      elif l.startswith('tick,'):
        p = l.rstrip('\n').split(','); ticks.append((int(p[2]), [int(x, 16) for x in [p[1]] + p[5:] if x and x != '0']))
    except ValueError: continue   # lines interleaved by concurrent writers
    if l.startswith('shared-library,'):
        p = l.split(','); libs.append((p[1], int(p[2], 16), int(p[3], 16)))
def loadsyms(f, base):
    a = []
    if not f: return [], []
    for l in open(f, errors='replace'):
        p = l.split()
        if len(p) >= 2:
            try: a.append((int(p[0], 16) + base, p[-1]))
            except: pass
    a.sort(); return [x[0] for x in a], [x[1] for x in a]
libcbase = next((lo for n, lo, hi in libs if 'libc.so' in n), 0)
nsa, nsn = loadsyms(nodesyms, 0); lsa, lsn = loadsyms(libcsyms, libcbase)
order = sorted(range(len(starts)), key=lambda i: starts[i]); ss = [starts[i] for i in order]
def code(pc, ts):
    i = bisect.bisect_right(ss, pc) - 1; best = None
    for j in range(i, max(-1, i - 80), -1):
        k = order[j]
        if starts[k] <= pc < ends[k] and cts[k] <= ts and (best is None or cts[k] > cts[best]): best = k
    return names[best] if best is not None else None
def sym(pc):
    for n, lo, hi in libs:
        if lo <= pc < hi:
            if 'libc.so' in n and lsa:
                k = bisect.bisect_right(lsa, pc) - 1; return 'libc:' + (lsn[k] if k >= 0 else '?')
            if n.endswith('/node') and pc < 0x4000000 and nsa:
                k = bisect.bisect_right(nsa, pc) - 1; return 'node:' + (nsn[k][:60] if k >= 0 else '?')
            return 'lib:' + n.split('/')[-1] + (':blob' if n.endswith('/node') and pc > 0x4000000 else '')
    return '?'
def short(n, pc):
    if n is None: return sym(pc)
    m = re.match(r'(\S*) file:///home/user/oxwasm/(\S+?):(\d+):\d+', n)
    if m: return 'js:' + m.group(1) + '@' + m.group(2).split('/')[-1] + ':' + m.group(3)
    if n.startswith('f_'): return 'unit'
    if n.startswith('wasm-function'): return 'jitunit'
    return 'b:' + n
cat = collections.Counter(); attr = collections.Counter(); pairs = collections.Counter(); tot = 0
for ts, frames in ticks:
    if ts < fr or ts > to: continue
    tot += 1
    top = short(code(frames[0], ts), frames[0])
    c = top if top in ('unit', 'jitunit') else top.split(':')[0]
    cat[c] += 1
    if c in ('unit', 'jitunit'): continue
    js = None
    for f in frames:
        s = short(code(f, ts), f)
        if s.startswith('js:'): js = s; break
        if s in ('unit', 'jitunit'): js = s + '>' + top; break
    attr[js or ('none>' + top)] += 1; pairs[(top, js or '-')] += 1
print('window rounds %d..%d  %d ms  ticks %d' % (fr_r, to_r, (to - fr) // 1000, tot))
for k, v in cat.most_common(): print('%6d %5.1f%% %s' % (v, 100 * v / tot, k))
print('--- non-unit ticks by nearest engine frame')
for k, v in attr.most_common(28): print('%5d %5.1f%% %s' % (v, 100 * v / tot, k))
print('--- (top, caller) pairs')
for (t, j), v in pairs.most_common(36): print('%5d  %s  <-  %s' % (v, t, j))
cw = collections.Counter()
for i in range(len(starts)):
    if fr <= cts[i] <= to: cw[('f_' if names[i].startswith('f_') else 'wf' if names[i].startswith('wasm-function') else 'other')] += 1
print('code creations in window:', dict(cw))
