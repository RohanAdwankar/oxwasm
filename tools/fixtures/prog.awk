# fields, arrays, functions, printf, sorting by key iteration
function sq(x) { return x * x }
{ n[$1 % 7]++; s += sq($1) % 1000 }
END { for (k = 0; k < 7; k++) printf "%d:%d ", k, n[k]; printf "\nsum=%d lines=%d\n", s, NR }
