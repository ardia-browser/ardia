#include <cstdio>
#include <cstdlib>
#include <string>
#include <string_view>

#include "ardia/core/ac_feature_switches.h"
#include "base/base_switches.h"
#include "base/command_line.h"

namespace {

int failures = 0;

void Expect(bool ok, std::string_view what) {
  if (!ok) {
    std::printf("FAIL %.*s\n", static_cast<int>(what.size()), what.data());
    ++failures;
  }
}

constexpr char kDump[] = "PartitionAllocUnretainedDanglingPtr:mode/dump_without_crashing";

base::CommandLine With(std::string_view enable, std::string_view disable) {
  base::CommandLine command_line;
  if (!enable.empty()) {
    command_line.AppendSwitchASCII(switches::kEnableFeatures, enable);
  }
  if (!disable.empty()) {
    command_line.AppendSwitchASCII(switches::kDisableFeatures, disable);
  }
  return command_line;
}

void ExpectReport(std::string_view enable, std::string_view disable, std::string_view expected_enable,
                  std::string_view what) {
  base::CommandLine command_line = With(enable, disable);
  ardiacore::ReportDanglingUnretainedWithoutCrashing(&command_line);
  const std::string got = command_line.GetSwitchValueASCII(switches::kEnableFeatures);
  if (got != expected_enable) {
    std::printf("  enable-features is \"%s\", expected \"%.*s\"\n", got.c_str(),
                static_cast<int>(expected_enable.size()), expected_enable.data());
  }
  Expect(got == expected_enable, what);
  Expect(command_line.GetSwitchValueASCII(switches::kDisableFeatures) == disable, what);
}

}

int main() {
  ExpectReport("", "", kDump, "a plain launch dumps instead of crashing");
  ExpectReport("WebContentsDiscard", "Glic", std::string("WebContentsDiscard,") + kDump,
               "other features stay and the mode joins them");
  ExpectReport("PartitionAllocUnretainedDanglingPtrSoon", "", std::string("PartitionAllocUnretainedDanglingPtrSoon,") + kDump,
               "a feature whose name only starts the same is a different feature");

  const char* const decided_enables[] = {
      "PartitionAllocUnretainedDanglingPtr",
      "PartitionAllocUnretainedDanglingPtr:mode/crash",
      "PartitionAllocUnretainedDanglingPtr.Custom:mode/crash",
      "PartitionAllocUnretainedDanglingPtr<Study",
      "PartitionAllocUnretainedDanglingPtr<Study.Group:mode/crash",
      "*PartitionAllocUnretainedDanglingPtr",
      "WebContentsDiscard, PartitionAllocUnretainedDanglingPtr.Custom:mode/crash",
      "Broken:a:b",
  };
  for (const char* enable : decided_enables) {
    ExpectReport(enable, "", enable, std::string("an explicit enable-features entry is left as the user set it: ") + enable);
  }

  ExpectReport("WebContentsDiscard", "OtherFeature<QA.Stage.Rollout", std::string("WebContentsDiscard,") + kDump,
               "a disabled feature whose trial name has dots is not this feature");
  ExpectReport("WebContentsDiscard", "Glic,OtherFeature<QA.Stage.Rollout,**PartitionAllocUnretainedDanglingPtr",
               std::string("WebContentsDiscard,") + kDump,
               "the disable list strips one default marker, as RegisterOverride does");

  const char* const decided_disables[] = {
      "PartitionAllocUnretainedDanglingPtr",
      "Glic,PartitionAllocUnretainedDanglingPtr<Study",
      "*PartitionAllocUnretainedDanglingPtr",
      "OtherFeature<QA.Stage.Rollout,PartitionAllocUnretainedDanglingPtr<QA.Stage.Rollout",
  };
  for (const char* disable : decided_disables) {
    ExpectReport("WebContentsDiscard", disable, "WebContentsDiscard",
                 std::string("a disabled feature stays disabled: ") + disable);
  }

  if (failures) {
    std::printf("%d feature switch checks failed\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("feature switch scenarios passed\n");
  return EXIT_SUCCESS;
}
