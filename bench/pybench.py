import time
def loop(n):
    s = 0
    for i in xrange(n):
        s += i*i % 7
    return s
t0 = time.time()
r = loop(3000000)
t1 = time.time()
print "loop3M", r, "%.0fms" % ((t1-t0)*1000)
d = {}
t0 = time.time()
for i in xrange(300000):
    d[i % 1000] = i
    x = d.get(i % 997, 0)
t1 = time.time()
print "dict300k", len(d), "%.0fms" % ((t1-t0)*1000)
s = []
t0 = time.time()
for i in xrange(200000):
    s.append(str(i))
j = len("".join(s))
t1 = time.time()
print "str200k", j, "%.0fms" % ((t1-t0)*1000)
