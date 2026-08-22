import gzip, re, sys, json

def parse(path):
    pkgs = {}
    cur = {}
    key = None
    with gzip.open(path, 'rt', errors='replace') as f:
        for line in f:
            if line == '\n':
                if 'Package' in cur: pkgs.setdefault(cur['Package'], cur)
                cur = {}; continue
            if line.startswith((' ', '\t')): continue
            if ':' in line:
                key, _, val = line.partition(':')
                cur[key] = val.strip()
    if 'Package' in cur: pkgs.setdefault(cur['Package'], cur)
    return pkgs

pkgs = {}
for p in ('main.gz', 'universe.gz'):
    for k, v in parse(p).items():
        pkgs.setdefault(k, v)

provides = {}
for name, meta in pkgs.items():
    for pv in re.split(r',\s*', meta.get('Provides', '')):
        pv = pv.split('(')[0].strip()
        if pv: provides.setdefault(pv, name)

def deps_of(meta):
    out = []
    for field in ('Pre-Depends', 'Depends'):
        for d in re.split(r',\s*', meta.get(field, '')):
            if not d.strip(): continue
            alts = [a.split('(')[0].split(':')[0].strip() for a in d.split('|')]
            pick = next((a for a in alts if a in pkgs), None)
            if not pick: pick = next((provides[a] for a in alts if a in provides), None)
            if pick: out.append(pick)
    return out

SKIP = {'debconf', 'debconf-2.0', 'dpkg', 'install-info', 'initscripts', 'lsb-base',
        'init-system-helpers', 'adduser', 'passwd', 'debianutils', 'ucf', 'sensible-utils',
        'x11-common', 'xfonts-utils', 'xfonts-encodings', 'keyboard-configuration', 'console-setup'}
roots = sys.argv[1:]
seen, order = set(), []
def visit(p):
    if p in seen or p in SKIP: return
    seen.add(p)
    if p not in pkgs:
        print(f"warn: {p} not found", file=sys.stderr); return
    for d in deps_of(pkgs[p]): visit(d)
    order.append(p)
for r in roots: visit(r)
total = sum(int(pkgs[p].get('Size', 0)) for p in order)
print(f"{len(order)} packages, {total/1e6:.0f} MB download", file=sys.stderr)
json.dump([{ 'name': p, 'file': pkgs[p]['Filename'], 'size': int(pkgs[p].get('Size',0))} for p in order], open('closure.json','w'))
