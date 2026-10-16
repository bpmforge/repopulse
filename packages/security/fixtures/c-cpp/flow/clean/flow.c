/* Clean near-misses: nothing here may fire. */
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MIN(a, b) ((a) < (b) ? (a) : (b))

void fixed_command(void) {
  system("ls -l /tmp");
}

void arg_as_vector(char **argv) {
  execl("/usr/bin/convert", "convert", "in.png", "out.png", (char *)0);
}

void fixed_path(void) {
  FILE *f = fopen("/etc/app.conf", "r");
  fclose(f);
}

void base_name_only(char **argv) {
  char *name = basename(argv[1]);
  FILE *f = fopen(name, "r");
  fclose(f);
}

void safe_echo(void) {
  char line[128];
  fgets(line, sizeof(line), stdin);
  printf("%s", line);
  fprintf(stderr, "%s\n", line);
}

void bounded_copy(char **argv) {
  char name[16];
  snprintf(name, sizeof(name), "%s", argv[1]);
}

void fixed_copy(void) {
  char name[16];
  strcpy(name, "default");
}

void clamped_size(char **argv) {
  char out[16];
  char in[256];
  int len = MIN(atoi(argv[2]), (int)sizeof(out));
  memcpy(out, in, len);
}

void constant_size(void) {
  char out[16];
  char in[16];
  memcpy(out, in, sizeof(out));
}
