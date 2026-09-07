// Iterative fibonacci: a loop with a carried dependency, the shape gcc turns
// into a two-register rotate with a decrementing counter.
long fib(long n) {
  long a = 0, b = 1;
  while (n-- > 0) { long t = a + b; a = b; b = t; }
  return a;
}
