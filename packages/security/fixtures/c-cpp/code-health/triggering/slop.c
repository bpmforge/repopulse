/* Triggering fixture for anti-slop.c-cpp.v1.yaml and logging.c-cpp.v1.yaml (W18-15). */
#include <stdio.h>
#include <stdlib.h>

#define STATUS_OK 0

int flush_cache(void) {
  /* TODO: actually flush */
  return STATUS_OK;
}

int save(const char *path) {
  // FIXME implement
  return 0;
}

void cleanup(char *buf) {
  /* free the buffer */
  free(buf);
  fprintf(stderr, "got here %p\n", (void *)buf);
  printf(">>> cleanup done\n");
}
