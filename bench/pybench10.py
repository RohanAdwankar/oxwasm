import time
def loop(n):
    s = 0
    for i in xrange(n):
        s += i*i % 7
    return s
loop(3000000)                    # warmup pass: tier everything first
t0 = time.time()
r = loop(30000000)
t1 = time.time()
print "loop30M", r, "%.0fms" % ((t1-t0)*1000)
d = {}
for i in xrange(300000):
    d[i % 1000] = i
    x = d.get(i % 997, 0)
t0 = time.time()
for i in xrange(3000000):
    d[i % 1000] = i
    x = d.get(i % 997, 0)
t1 = time.time()
print "dict3M", len(d), "%.0fms" % ((t1-t0)*1000)
s = []
for i in xrange(200000):
    s.append(str(i))
j = len("".join(s))
s = []
t0 = time.time()
for i in xrange(2000000):
    s.append(str(i))
j = len("".join(s))
t1 = time.time()
print "str2M", j, "%.0fms" % ((t1-t0)*1000)
