/* cppcheck adapter fixture (W18-15): defects cppcheck reports and our
 * semgrep pack does not, plus one both see (the realloc self-assignment). */
#include <stdlib.h>
#include <string.h>

int last_element(void) {
  int values[4] = {1, 2, 3, 4};
  return values[4];
}

char *grow(size_t n) {
  char *buf = malloc(16);
  if (buf == NULL) return NULL;
  buf = realloc(buf, n);
  return buf;
}

void leak(size_t n) {
  char *scratch = malloc(n);
  if (scratch == NULL) return;
  scratch[0] = 0;
}

int uninit(void) {
  int total;
  return total + 1;
}

void copy_name(char *dst, const char *src) {
  strcpy(dst, src);
}

int compare(const char *a) {
  return a == "literal";
}
