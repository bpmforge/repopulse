/* Triggering fixture for bpm-baseline.c-cpp.v1.yaml (W18-15).
 * Every function here contains the defect its name describes. */
#include <alloca.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <syslog.h>
#include <time.h>

struct record {
  int id;
  char name[32];
};

void read_line(void) {
  char line[64];
  gets(line);
  puts(line);
}

void copy_name(char *dst, const char *user_input) {
  strcpy(dst, user_input);
  strcat(dst, user_input);
}

void greet(char *out, const char *name) {
  sprintf(out, "hello, %s", name);
}

void read_word(FILE *in) {
  char word[64];
  scanf("%s", word);
  fscanf(in, "%d %[^\n]", &word[0], word);
}

void log_message(const char *msg) {
  printf(msg);
  fprintf(stderr, msg);
  syslog(LOG_INFO, msg);
}

void convert(const char *filename) {
  char cmd[256];
  snprintf(cmd, sizeof(cmd), "convert %s out.png", filename);
  system(cmd);
}

void list_dir(const char *dir) {
  char cmd[256] = "ls ";
  strcat(cmd, dir);
  FILE *p = popen(cmd, "r");
  pclose(p);
}

void copy_header(char *dst, const char *src) {
  memcpy(dst, src, sizeof(dst));
}

void copy_local(const char *src) {
  char storage[64];
  char *buf = storage;
  memmove(buf, src, sizeof(buf));
}

void fill(int n) {
  char *p = malloc(n);
  p[0] = 'x';
  free(p);
}

void fill_record(void) {
  struct record *r = (struct record *)calloc(1, sizeof(*r));
  r->id = 7;
  free(r);
}

void fill_copy(const char *src, size_t n) {
  char *p;
  p = malloc(n);
  memcpy(p, src, n);
  free(p);
}

int grow(char **buf, size_t n) {
  char *p = *buf;
  p = realloc(p, n * 2);
  *buf = p;
  return p != NULL;
}

void make_session_token(char *out, size_t n) {
  srand(time(NULL));
  for (size_t i = 0; i < n; i++) out[i] = 'a' + rand() % 26;
}

void new_user(int *password_seed) {
  *password_seed = 0;
  int reset_token = rand();
  (void)reset_token;
}

void copy_label(char *label, const char *src) {
  strncpy(label, src, 16);
  puts(label);
}

void scratch(size_t n) {
  char *tmp = alloca(n);
  tmp[0] = 0;
}
