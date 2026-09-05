# cmake fixture (docs/m3-engine.md): script mode (-P) exercises the
# interpreter without a generator: lists, math, string ops, regex, file I/O
set(L 3 1 2)
list(SORT L)
math(EXPR S "7 * 6")
string(TOUPPER "breadth" U)
string(REGEX REPLACE "[aeiou]" "_" V "generality")
file(WRITE /tmp/bcm/out.txt "${L};${S};${U};${V}\n")
file(READ /tmp/bcm/out.txt R)
message(STATUS "${R}")
