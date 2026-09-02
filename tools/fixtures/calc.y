/* bison fixture (docs/m3-engine.md): a small LALR(1) grammar; the generated
 * parser is byte-compared to native bison's (its header banner carries no
 * timestamps; -o names the output). */
%{
#include <stdio.h>
int yylex(void); void yyerror(const char *s) { fprintf(stderr, "%s\n", s); }
%}
%token NUM
%left '+' '-'
%left '*' '/'
%%
input: %empty | input line ;
line: '\n' | exp '\n' { printf("%d\n", $1); } ;
exp: NUM | exp '+' exp { $$ = $1 + $3; } | exp '-' exp { $$ = $1 - $3; }
   | exp '*' exp { $$ = $1 * $3; } | exp '/' exp { $$ = $1 / $3; } | '(' exp ')' { $$ = $2; } ;
%%
