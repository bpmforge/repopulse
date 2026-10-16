/* Clean fixture for anti-slop.c-cpp.v1.yaml and logging.c-cpp.v1.yaml (W18-15). */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

int flush_cache(void) {
  /* TODO: flush asynchronously once the writer thread lands */
  return -ENOSYS;
}

int save(const char *path) {
  FILE *f = fopen(path, "w");
  if (!f) return -1;
  return fclose(f);
}

void cleanup(char *buf) {
  /* The caller may still hold a view into buf; release it only once. */
  free(buf);
  fprintf(stderr, "error: cleanup failed for %s\n", "cache");
  printf("Here is the summary:\n");
  printf("debug mode is %s\n", "off");
}
