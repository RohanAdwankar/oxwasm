# threads + queue + lock: producers/consumers over futex-backed primitives
import threading, queue
q = queue.Queue(); lock = threading.Lock(); total = [0]
def producer(n):
    for i in range(200): q.put(n * 1000 + i)
def consumer():
    while True:
        v = q.get()
        if v is None: break
        with lock: total[0] += v
        q.task_done()
ps = [threading.Thread(target=producer, args=(k,)) for k in range(4)]
cs = [threading.Thread(target=consumer) for _ in range(3)]
for t in cs + ps: t.start()
for t in ps: t.join()
q.join()
for _ in cs: q.put(None)
for t in cs: t.join()
print('total', total[0], 'threads', len(ps) + len(cs))
