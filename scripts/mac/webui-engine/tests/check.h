#ifndef ARDIA_MAC_TESTS_CHECK_H_
#define ARDIA_MAC_TESTS_CHECK_H_

#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string_view>
#include <utility>
#include <vector>

namespace ardia_mac_test {

inline int& Failures() {
  static int failures = 0;
  return failures;
}

inline std::vector<std::pair<std::string_view, std::function<void()>>>& Cases() {
  static std::vector<std::pair<std::string_view, std::function<void()>>> cases;
  return cases;
}

struct Register {
  Register(std::string_view name, std::function<void()> run) { Cases().emplace_back(name, std::move(run)); }
};

inline void Fail(const char* file, int line, const char* expression) {
  std::fprintf(stderr, "%s:%d: CHECK failed: %s\n", file, line, expression);
  ++Failures();
}

inline bool Near(double a, double b) {
  return std::fabs(a - b) < 1e-9;
}

inline int RunAll(int argc, char** argv) {
  int ran = 0;
  for (const auto& [name, run] : Cases()) {
    if (argc > 1 && name != argv[1]) continue;
    const int before = Failures();
    run();
    ++ran;
    std::printf("%s %.*s\n", Failures() == before ? "ok  " : "FAIL", static_cast<int>(name.size()), name.data());
  }
  if (ran == 0) {
    std::fprintf(stderr, "no case named %s\n", argc > 1 ? argv[1] : "");
    return 2;
  }
  return Failures() == 0 ? 0 : 1;
}

}

#define CHECK(expression)                                                   \
  do {                                                                      \
    if (!(expression)) ::ardia_mac_test::Fail(__FILE__, __LINE__, #expression); \
  } while (false)

#define CHECK_NEAR(a, b) CHECK(::ardia_mac_test::Near((a), (b)))

#define TEST_CASE_NAME2(line) test_case_##line
#define TEST_CASE_NAME(line) TEST_CASE_NAME2(line)
#define TEST(name)                                                                         \
  static void name();                                                                      \
  static const ::ardia_mac_test::Register TEST_CASE_NAME(__LINE__)(#name, &name);          \
  static void name()

#endif
