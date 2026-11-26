#include "ardia/mac/ac_mac_webui_policy.h"

#include <optional>
#include <string>
#include <string_view>

#include "check.h"

namespace policy = ardia_mac::webui_policy;
using policy::Build;
using policy::Decision;
using std::nullopt;

TEST(release_refuses_switch) {
  CHECK(policy::Decide(Build::kRelease, "webui", nullopt) == Decision::kRefusedInRelease);
  CHECK(!policy::Active(policy::Decide(Build::kRelease, "webui", nullopt)));
}

TEST(release_refuses_environment) {
  CHECK(policy::Decide(Build::kRelease, nullopt, "webui") == Decision::kRefusedInRelease);
  CHECK(!policy::Active(policy::Decide(Build::kRelease, nullopt, "webui")));
}

TEST(release_refuses_both) {
  CHECK(!policy::Active(policy::Decide(Build::kRelease, "webui", "webui")));
  CHECK(!policy::Active(policy::Decide(Build::kRelease, "native", "webui")));
}

TEST(release_without_request_is_off) {
  CHECK(policy::Decide(Build::kRelease, nullopt, nullopt) == Decision::kOff);
  CHECK(policy::Decide(Build::kRelease, "native", nullopt) == Decision::kOff);
}

TEST(development_needs_an_explicit_request) {
  CHECK(policy::Decide(Build::kDevelopment, nullopt, nullopt) == Decision::kOff);
  CHECK(policy::Decide(Build::kDevelopment, nullopt, "") == Decision::kOff);
  CHECK(!policy::Active(policy::Decide(Build::kDevelopment, nullopt, nullopt)));
}

TEST(development_switch_turns_it_on) {
  CHECK(policy::Decide(Build::kDevelopment, "webui", nullopt) == Decision::kOnFromSwitch);
  CHECK(policy::Active(policy::Decide(Build::kDevelopment, "webui", nullopt)));
}

TEST(development_environment_turns_it_on) {
  CHECK(policy::Decide(Build::kDevelopment, nullopt, "webui") == Decision::kOnFromEnvironment);
  CHECK(policy::Active(policy::Decide(Build::kDevelopment, nullopt, "webui")));
}

TEST(development_switch_beats_environment) {
  CHECK(policy::Decide(Build::kDevelopment, "native", "webui") == Decision::kOffBySwitch);
  CHECK(policy::Decide(Build::kDevelopment, "", "webui") == Decision::kOffBySwitch);
  CHECK(policy::Decide(Build::kDevelopment, "webui", "native") == Decision::kOnFromSwitch);
}

TEST(values_match_exactly) {
  for (std::string_view value : {"WebUI", "WEBUI", " webui", "webui ", "webui=1", "web", "webuix"}) {
    CHECK(!policy::Active(policy::Decide(Build::kDevelopment, value, nullopt)));
    CHECK(!policy::Active(policy::Decide(Build::kDevelopment, nullopt, value)));
  }
  constexpr char embedded[] = {'w', 'e', 'b', 'u', 'i', '\0', 'x'};
  CHECK(!policy::Active(policy::Decide(Build::kDevelopment, std::string_view(embedded, 7), nullopt)));
}

TEST(compiled_build_follows_defines) {
#if defined(EXPECT_DEVELOPMENT)
  CHECK(policy::CompiledBuild() == Build::kDevelopment);
  CHECK(policy::ShouldStart("webui", nullopt));
  CHECK(policy::ShouldStart(nullopt, "webui"));
#else
  CHECK(policy::CompiledBuild() == Build::kRelease);
  CHECK(!policy::ShouldStart("webui", nullopt));
  CHECK(!policy::ShouldStart(nullopt, "webui"));
  CHECK(!policy::ShouldStart("webui", "webui"));
#endif
  CHECK(!policy::ShouldStart(nullopt, nullopt));
}

TEST(decisions_are_described) {
  for (Decision decision : {Decision::kOff, Decision::kOnFromSwitch, Decision::kOnFromEnvironment,
                            Decision::kRefusedInRelease, Decision::kOffBySwitch}) {
    CHECK(!policy::Describe(decision).empty());
  }
}

static_assert(!policy::Active(policy::Decide(Build::kRelease, "webui", "webui")));
static_assert(policy::Active(policy::Decide(Build::kDevelopment, "webui", std::nullopt)));

TEST(background_from_switch_or_environment) {
  CHECK(policy::Background(true, nullopt));
  CHECK(policy::Background(false, "1"));
  CHECK(policy::Background(false, "true"));
  CHECK(policy::Background(true, "0"));
  CHECK(!policy::Background(false, nullopt));
  for (std::string_view value : {"", "0", "false", "TRUE", "yes", " 1", "1 ", "10", "true\n"}) {
    CHECK(!policy::Background(false, value));
  }
}

TEST(hostile_sinks) {
  constexpr char nul_webui[] = {'w', 'e', 'b', 'u', 'i', '\0'};
  const std::string long_value(100000, 'w');
  for (std::string_view value : {std::string_view(nul_webui, 6), std::string_view(long_value), std::string_view("\x7fwebui"),
                                 std::string_view("webui\r\n"), std::string_view("../webui"), std::string_view("%77ebui")}) {
    CHECK(!policy::Active(policy::Decide(Build::kDevelopment, value, nullopt)));
    CHECK(!policy::Active(policy::Decide(Build::kDevelopment, nullopt, value)));
    CHECK(!policy::Active(policy::Decide(Build::kRelease, value, value)));
    CHECK(!policy::Background(false, value));
  }
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
