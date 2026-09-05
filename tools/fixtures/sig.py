# a timer signal interrupts sleep; Python (PEP 475) retries the sleep so the
# full interval elapses and the handler has run once
import signal, time
got = []
signal.signal(signal.SIGALRM, lambda s, f: got.append(s))
signal.setitimer(signal.ITIMER_REAL, 0.02)
t = time.monotonic(); time.sleep(0.3)
print('slept_full', time.monotonic() - t > 0.25, 'got', got)
