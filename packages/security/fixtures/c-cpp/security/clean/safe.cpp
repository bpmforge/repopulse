// Clean fixture (C++ side) for bpm-baseline.c-cpp.v1.yaml (W18-15).
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unistd.h>

void remove_dir(const std::string &name) {
  const char *argv[] = {"rm", "-rf", name.c_str(), nullptr};
  execv("/bin/rm", const_cast<char *const *>(argv));
}

void sync_disks() {
  std::string cmd = "sync";
  system(cmd.c_str());
}

void report(const std::string &msg) {
  printf("%s\n", msg.c_str());
}
