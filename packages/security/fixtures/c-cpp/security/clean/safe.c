/* Clean fixture for bpm-baseline.c-cpp.v1.yaml (W18-15): the same jobs as the
 * triggering file, done safely, plus the near-misses each rule must ignore. */
#include <alloca.h>
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <syslog.h>
#include <sys/random.h>

#define USAGE "usage: tool [-v] file\n"
#define MAX_ITEMS 16
#define _(s) (s)

struct record {
  int id;
  char name[32];
};

struct table {
  char *slots;
};

void read_line(void) {
  char line[64];
  if (fgets(line, sizeof(line), stdin)) puts(line);
}

void copy_name(char *dst, size_t n, const char *user_input) {
  snprintf(dst, n, "%s", user_input);
  strcpy(dst, "default");
  strcat(dst, ".conf");
}

void format_id(char *out, int id) {
  sprintf(out, "%08d", id);
  sprintf(out, "%x-%u", id, (unsigned)id);
}

void read_word(FILE *in) {
  char word[64];
  int n;
  scanf("%63s", word);
  fscanf(in, "%d %63[^\n]", &n, word);
  sscanf("a b", "%*s %63s", word);
  scanf("100%%sure %d", &n);
}

void log_message(const char *msg, int code) {
  printf("%s\n", msg);
  fprintf(stderr, "%s: %d\n", msg, code);
  syslog(LOG_INFO, "%s", msg);
  printf(USAGE);
  printf(_("translated text\n"));
  printf("plain literal\n");
}

void vlog(FILE *out, const char *fmt, int a) {
  fprintf(out, fmt, a);
}

void reload(int pid) {
  char cmd[64];
  snprintf(cmd, sizeof(cmd), "kill -HUP %d", pid);
  system(cmd);
  system("sync");
}

void copy_header(char *dst, const char *src, size_t n) {
  memcpy(dst, src, n);
}

void copy_local(const char *src) {
  char storage[64];
  memcpy(storage, src, sizeof(storage));
  struct record rec;
  struct record *rp = &rec;
  memcpy(rp, src, sizeof(*rp));
}

void fill(int n) {
  char *p = malloc(n);
  if (p == NULL) return;
  p[0] = 'x';
  free(p);
}

void fill_record(void) {
  struct record *r = calloc(1, sizeof(*r));
  if (!r) {
    abort();
  }
  r->id = 7;
  free(r);
}

void fill_assert(int n) {
  char *p = malloc(n);
  assert(p != NULL);
  p[0] = 'x';
  free(p);
}

void fill_inline(int n) {
  char *p;
  if ((p = malloc(n)) == NULL) return;
  p[0] = 'x';
  free(p);
}

void fill_guarded(int n) {
  char *p = malloc(n);
  if (p) {
    p[0] = 'x';
  }
  free(p);
}

void fill_macro_checked(int n) {
  char *p = malloc(n);
  CHECK_ALLOC(p);
  memset(p, 0, n);
  free(p);
}

int grow(struct table *t, size_t n) {
  char *bigger = realloc(t->slots, n * 2);
  if (bigger == NULL) return 0;
  t->slots = bigger;
  return 1;
}

void make_session_token(unsigned char *out, size_t n) {
  getrandom(out, n, 0);
}

int shuffle_deck(int *deck, int n) {
  int i = rand() % n;
  int cache_key = rand();
  return deck[i] + cache_key;
}

void copy_label(char *label, const char *src) {
  char fixed[16] = {0};
  strncpy(fixed, src, sizeof(fixed) - 1);
  strncpy(label, src, 16);
  label[15] = '\0';
}

void scratch(void) {
  char *a = alloca(64);
  char *b = alloca(sizeof(struct record));
  char *c = alloca(MAX_ITEMS);
  a[0] = b[0] = c[0] = 0;
}

char *dup_name(const char *name) {
  char *copy = calloc(1, strlen(name) + 1);
  if (copy == NULL) return NULL;
  strcpy(copy, name);
  return copy;
}

void bounded(char dst[64], const char *src) {
  if (strlen(src) < 64) strcpy(dst, src);
}
