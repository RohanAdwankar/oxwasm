dnl m4 fixture (docs/m3-engine.md): macros, recursion, arithmetic, strings
define(`sq', `eval($1*$1)')dnl
define(`fact', `ifelse($1, 0, 1, `eval($1 * fact(decr($1)))')')dnl
define(`rep', `ifelse($2, 0, `', `$1`'rep(`$1', decr($2))')')dnl
sq(12) fact(10) rep(`ab', 5)
len(`breadth') substr(`generality', 3, 4) translit(`hello', `a-y', `b-z')
regexp(`m4 fixture 2026', `[0-9]+', `<\&>') index(`interpreter', `pre')
esyscmd(`printf x')divert(-1)
hidden text
divert(0)dnl
forloop: define(`i', 0)dnl
define(`loop', `ifelse(eval(i < 5), 1, `i define(`i', incr(i))loop')')dnl
loop
