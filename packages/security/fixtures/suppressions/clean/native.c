#pragma once
#pragma warning(push)
#pragma GCC diagnostic push
// #pragma warning(disable: 4996)
/* #pragma GCC diagnostic ignored "-Wall" */
#include <stdio.h>

static const char *text = "#pragma warning(disable: 4996)";
static const long big = 1'000'000;

int main(void) { return printf("%s %ld\n", text, big); }
#pragma GCC diagnostic pop
#pragma warning(pop)
