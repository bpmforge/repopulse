/* Triggering fixture for bpm-baseline.c-cpp-flow.v1.yaml (W18-44).
 * `// ruleid: <id>` names the rule that must fire on the NEXT line. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>

void run_from_argv(int argc, char **argv) {
  char *tool = argv[1];
  // ruleid: bpm-flow-cmd-c
  system(tool);
}

void run_from_stream(void) {
  char line[128];
  fgets(line, sizeof(line), stdin);
  // ruleid: bpm-flow-cmd-c
  FILE *p = popen(line, "r");
  pclose(p);
}

void open_from_env(void) {
  char *home = getenv("REPORT_DIR");
  // ruleid: bpm-flow-path-c
  FILE *f = fopen(home, "r");
  fclose(f);
}

void remove_from_argv(char **argv) {
  // ruleid: bpm-flow-path-c
  unlink(argv[1]);
}

void echo_line(void) {
  char line[128];
  fgets(line, sizeof(line), stdin);
  // ruleid: bpm-flow-format-c
  printf(line);
}

void log_arg(char **argv) {
  // ruleid: bpm-flow-format-c
  fprintf(stderr, argv[1]);
}

void copy_socket(int fd) {
  char buf[256];
  char name[32];
  recv(fd, buf, sizeof(buf), 0);
  // ruleid: bpm-flow-copy-c
  strcpy(name, buf);
}

void copy_arg(char **argv) {
  char name[16];
  // ruleid: bpm-flow-copy-c
  strcpy(name, argv[1]);
}

void copy_len(char **argv) {
  char out[16];
  char in[256];
  int len = atoi(argv[2]);
  // ruleid: bpm-flow-size-c
  memcpy(out, in, len);
}

void copy_read(int fd) {
  char out[16];
  char in[256];
  ssize_t n = read(fd, in, sizeof(in));
  // ruleid: bpm-flow-size-c
  memcpy(out, in, n);
}
