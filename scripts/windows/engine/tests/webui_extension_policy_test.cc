#include "ardia/win/webui/webui_extension_policy.h"

#include <cassert>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

using namespace ardia_win::webui_extension;

void TestActionStatesRequest() {
  assert(ActionStatesRequestFits("{\"tabId\":\"t\",\"ids\":[]}"));
  assert(ActionStatesRequestFits(std::string(kActionStatesRequestLimit, ' ')));
  assert(!ActionStatesRequestFits(
      std::string(kActionStatesRequestLimit + 1, ' ')));
  assert(!ActionStatesRequestFits(""));
  assert(!ActionStatesRequestFits(std::string("{\0}", 3)));
}

void TestViewCoordinates() {
  assert(ViewCoordinateInRange(0));
  assert(ViewCoordinateInRange(-12.5));
  assert(ViewCoordinateInRange(kViewCoordinateLimit));
  assert(ViewCoordinateInRange(-kViewCoordinateLimit));
  assert(!ViewCoordinateInRange(kViewCoordinateLimit + 1));
  assert(!ViewCoordinateInRange(-kViewCoordinateLimit - 1));
  assert(!ViewCoordinateInRange(1e300));
  assert(!ViewCoordinateInRange(std::numeric_limits<double>::max()));
  assert(!ViewCoordinateInRange(std::numeric_limits<double>::infinity()));
  assert(!ViewCoordinateInRange(std::nan("")));
  const double zoom = 5.0;
  const double device_scale = 4.0;
  assert(kViewCoordinateLimit * zoom * device_scale * 2 <
         static_cast<double>(std::numeric_limits<int>::max()));
}

void TestViewProfiles() {
  assert(ViewProfileMatches("default", "default"));
  assert(ViewProfileMatches("incognito:w-2@work", "incognito:w-2@work"));
  assert(!ViewProfileMatches("incognito:w-3@work", "incognito:w-2@work"));
  assert(!ViewProfileMatches("private@work", "incognito:w-2@work"));
  assert(!ViewProfileMatches("work", "incognito:w-2@work"));
  assert(!ViewProfileMatches("", ""));
  assert(!ViewProfileMatches("default", ""));
}

void TestViewIdsSurviveRegistryChanges() {
  ViewIds ids;
  const std::optional<int> first = ids.Assign(1, 7);
  assert(first == 1);
  assert(ids.Internal(*first) == 1);
  assert(ids.External(1) == first);
  ids.Clear();
  const std::optional<int> second = ids.Assign(1, 7);
  assert(second && *second != *first);
  assert(ids.Internal(*first) == 0);
  assert(ids.Internal(*second) == 1);
  ids.Forget(*first);
  assert(ids.Internal(*second) == 1);
  ids.Forget(*second);
  assert(ids.Internal(*second) == 0);
  assert(!ids.External(1));

  const std::optional<int> old_view = ids.Assign(2, 7);
  const std::optional<int> new_view = ids.Assign(3, 8);
  ids.ForgetOlderThan(8);
  assert(ids.Internal(*old_view) == 0);
  assert(ids.Internal(*new_view) == 3);

  assert(!ids.Assign(0, 8));
  assert(!ids.Assign(-1, 8));
  ids.Clear();
  int last = 0;
  for (int i = 1; i <= static_cast<int>(kViewIdLimit) * 3; ++i) {
    const std::optional<int> external = ids.Assign(i, 9);
    assert(external && *external > last);
    last = *external;
    assert(ids.size() <= kViewIdLimit);
  }
  assert(ids.Internal(0) == 0);
  assert(ids.Internal(-1) == 0);
  assert(ids.Internal(std::numeric_limits<int>::max()) == 0);
}

std::string Unhex(const std::string& hex) {
  std::string out;
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    out.push_back(static_cast<char>(std::stoi(hex.substr(i, 2), nullptr, 16)));
  }
  return out;
}

int RunHostileCorpus(const char* path) {
  std::ifstream in(path);
  std::string line;
  size_t values = 0;
  size_t strings = 0;
  size_t numbers = 0;
  ViewIds ids;
  const int live = *ids.Assign(1, 1);
  while (std::getline(in, line)) {
    ++values;
    if (line.rfind("s:", 0) == 0) {
      ++strings;
      const std::string value = Unhex(line.substr(2));
      if (ActionStatesRequestFits(value)) {
        assert(!value.empty() && value.size() <= kActionStatesRequestLimit &&
               value.find('\0') == std::string::npos);
      }
      assert(ViewProfileMatches(value, "default") == (value == "default"));
      assert(ViewProfileMatches(value, "incognito:w-1@default") ==
             (value == "incognito:w-1@default"));
      assert(!ViewProfileMatches(value, ""));
      continue;
    }
    if (line.rfind("d:", 0) == 0 || line.rfind("i:", 0) == 0) {
      ++numbers;
      const double value = std::strtod(line.c_str() + 2, nullptr);
      if (ViewCoordinateInRange(value)) {
        assert(std::isfinite(value) && std::abs(value) <= kViewCoordinateLimit);
      }
      if (line[0] == 'i') {
        const long long id = std::strtoll(line.c_str() + 2, nullptr, 10);
        const int external = static_cast<int>(id);
        assert(ids.Internal(external) == (external == live ? 1 : 0));
      }
    }
  }
  assert(ids.Internal(live) == 1);
  std::cout << "hostile: " << values << " values, " << strings << " strings, "
            << numbers << " numbers\n";
  return values > 0 ? 0 : 1;
}

}

int main(int argc, char** argv) {
  if (argc == 3 && std::string(argv[1]) == "--hostile") {
    return RunHostileCorpus(argv[2]);
  }
  TestActionStatesRequest();
  TestViewCoordinates();
  TestViewProfiles();
  TestViewIdsSurviveRegistryChanges();
  std::cout << "webui_extension_policy_test: all assertions passed\n";
  return 0;
}
