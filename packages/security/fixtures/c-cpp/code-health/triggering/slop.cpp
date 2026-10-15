// Triggering fixture for anti-slop.c-cpp.v1.yaml and logging.c-cpp.v1.yaml (W18-15).
#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>

int parse(const std::string &s);

int load_config(const std::string &path) {
  try {
    return parse(path);
  } catch (...) {
  }
  try {
    return parse(path + ".bak");
  } catch (const std::exception &e) {
    // ignore
  }
  return -1;
}

bool is_valid(const std::string &s) {
  try {
    return parse(s) > 0;
  } catch (...) {
    return false;
  }
}

bool export_report(const std::string &path) {
  // TODO: write the report
  return true;
}

int sync_remote() {
  throw std::logic_error("not implemented yet");
}

void count(int &n) {
  // increment the counter
  n++;
  std::cerr << "DEBUG: n=" << n << std::endl;
}
