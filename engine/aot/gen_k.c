#include <stdio.h>
#include <math.h>
int main(void) {
    printf("static const unsigned K[64] = {\n");
    for (int i = 0; i < 64; i++)
        printf("0x%08xu,%s", (unsigned)(fabs(sin(i + 1)) * 4294967296.0), i % 4 == 3 ? "\n" : " ");
    printf("};\n");
    return 0;
}
