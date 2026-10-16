// Clean near-misses: nothing here may fire.
#include <cstdlib>
#include <fstream>

int main(int argc, char **argv) {
  std::system("date");
  std::ifstream in("/etc/hostname");
  return 0;
}
