// Clean fixture for anti-slop.c-cpp.v1.yaml and logging.c-cpp.v1.yaml (W18-15):
// the same jobs, with failures handled and said out loud.
#include <cstdio>
#include <iostream>
#include <stdexcept>
#include <string>

int parse(const std::string &s);
void log_error(const char *what);

int load_config(const std::string &path) {
  try {
    return parse(path);
  } catch (const std::invalid_argument &e) {
    log_error(e.what());
    return -1;
  } catch (...) {
    log_error("unexpected failure parsing config");
    throw;
  }
}

bool is_valid(const std::string &s) {
  try {
    return parse(s) > 0;
  } catch (const std::invalid_argument &) {
    // A malformed value is "not valid" by definition; other failures propagate.
    return false;
  }
}

bool export_report(const std::string &path) {
  // TODO: support CSV as well as JSON
  if (path.empty()) return false;
  return write_json(path);
}

int sync_remote() {
  throw std::runtime_error("remote is unreachable");
}

void count(int &n) {
  // Saturate rather than wrap: callers compare against INT_MAX.
  if (n < 2147483647) n++;
  std::cerr << "warning: n=" << n << std::endl;
  std::cout << "debugging disabled in release builds" << std::endl;
}

bool probe(const std::string &s) {
  try {
    return parse(s) > 0;
  } catch (std::out_of_range &e) {
    return false;
  }
}

int to_int(const std::string &s) {
  try {
    return std::stoi(s);
  } catch (const std::invalid_argument &) {
    // Not a number: the caller treats 0 as "unset", which is what we want.
  }
  return 0;
}

int maybe(int x) {
  if (x > 3) {
    // TODO: report this as a bailout once the logger is threaded through
    return 0;
  }
  return x;
}
