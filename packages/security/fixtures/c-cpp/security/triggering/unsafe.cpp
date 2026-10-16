// Triggering fixture (C++ side) for bpm-baseline.c-cpp.v1.yaml (W18-15).
#include <cstdio>
#include <cstdlib>
#include <string>

void remove_dir(const std::string &name) {
  std::string cmd = "rm -rf " + name;
  system(cmd.c_str());
}

void archive(const std::string &name) {
  system(("tar czf out.tgz " + name).c_str());
}

void grep_for(const std::string &needle) {
  std::string cmd = "grep -r ";
  cmd += needle;
  FILE *p = popen(cmd.c_str(), "r");
  pclose(p);
}

void report(const std::string &msg) {
  printf(msg.c_str());
}
