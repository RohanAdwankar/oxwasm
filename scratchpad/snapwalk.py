# Retainer walk over a V8 .heapsnapshot: for objects whose constructor name
# matches TARGET, print the shortest chain from a GC root (node names and edge
# names), so the thing that pins them is visible. Streams the big arrays with
# numpy instead of json (a 1 GB heap is a 2 GB file; json.load would need 15 GB).
import sys, json, re, collections
import numpy as np
path = sys.argv[1]; TARGET = sys.argv[2] if len(sys.argv) > 2 else 'LinuxEngine'
data = open(path, 'rb').read()
def arr(key):
    i = data.index(b'"' + key + b'":[') + len(key) + 4
    j = data.index(b']', i)
    seg = data[i:j]
    return np.fromstring(seg, dtype=np.int64, sep=',') if seg.strip() else np.zeros(0, dtype=np.int64), j
meta_i = data.index(b'"meta":'); meta_j = data.index(b'"node_count"')
meta = json.loads(b'{' + data[meta_i:meta_j].rstrip().rstrip(b',') + b'}')['meta']
nf = meta['node_fields']; ef = meta['edge_fields']; ntypes = meta['node_types'][0]; etypes = meta['edge_types'][0]
nodes, _ = arr(b'nodes'); edges, _ = arr(b'edges')
si = data.index(b'"strings":[') + len(b'"strings":['); sj = data.rindex(b']')
strings = json.loads(b'[' + data[si:sj] + b']')
del data
NF, EF = len(nf), len(ef)
N = nodes.size // NF; E = edges.size // EF
n_type = nodes[0::NF]; n_name = nodes[1::NF]; n_id = nodes[2::NF]; n_size = nodes[3::NF]; n_ecount = nodes[4::NF]
e_type = edges[0::EF]; e_name = edges[1::EF]; e_to = edges[2::EF] // NF
first_edge = np.zeros(N + 1, dtype=np.int64); np.cumsum(n_ecount, out=first_edge[1:])
e_from = np.repeat(np.arange(N), n_ecount)
print(f'nodes {N} edges {E} strings {len(strings)}')
order = np.argsort(e_to, kind='stable'); to_sorted = e_to[order]
rev_first = np.searchsorted(to_sorted, np.arange(N + 1))
ti_object = ntypes.index('object'); ti_synth = ntypes.index('synthetic')
name = lambda n: strings[n_name[n]] if ntypes[n_type[n]] != 'string' else repr(strings[n_name[n]][:40])
ename = lambda e: strings[e_name[e]] if etypes[e_type[e]] in ('property', 'internal', 'shortcut', 'weak', 'context') else str(e_name[e])
targets = [n for n in range(N) if n_type[n] == ti_object and strings[n_name[n]] == TARGET]
print(f'{TARGET} objects: {len(targets)}', [int(n_size[t]) for t in targets][:10])
# retained size proxy: count of nodes dominated is expensive; report shallow sizes and the chains
roots = set(np.where(n_type == ti_synth)[0].tolist())
for t in targets[:6]:
    # BFS backwards over non-weak edges to a synthetic root
    prev = {t: None}; dq = collections.deque([t]); found = None
    while dq and found is None:
        n = dq.popleft()
        for k in range(rev_first[n], rev_first[n + 1]):
            e = order[k]
            if etypes[e_type[e]] == 'weak': continue
            f = int(e_from[e])
            if f in prev: continue
            prev[f] = (n, e); 
            if f in roots: found = f; break
            dq.append(f)
    if found is None: print(f'-- {TARGET}@{n_id[t]}: no root path (only weak edges?)'); continue
    chain = []; n = found
    while n is not None and n != t:
        nxt, e = prev[n]; chain.append(f'{name(n)} --{etypes[e_type[e]]}:{ename(e)}--> '); n = nxt
    print(f'-- {TARGET}@{n_id[t]} size {n_size[t]}:\n   ' + ''.join(chain) + name(t))
