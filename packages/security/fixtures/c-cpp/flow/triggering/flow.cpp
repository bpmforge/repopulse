// Triggering fixture for bpm-baseline.c-cpp-flow.v1.yaml (W18-44).
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
#include <cstdlib>
#include <cstring>
#include <iostream>

int main(int argc, char **argv) {
  const char *tool = std::getenv("TOOL");
  // ruleid: bpm-flow-cmd-c
  std::system(tool);

  char name[16];
  // ruleid: bpm-flow-copy-c
  strcpy(name, argv[2]);
  return 0;
}
