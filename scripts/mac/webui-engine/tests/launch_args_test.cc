#include "launch_args.h"

#include <string>
#include <vector>

#include "check.h"

namespace {

std::vector<std::string> Build(std::vector<const char*> argv, const char* data, const char* background,
                               const char* home = "/Users/tester") {
  ArdiaLaunchStorage storage;
  std::vector<const char*> out(argv.size() + kArdiaLaunchExtraArgs + 1, nullptr);
  const int count = ArdiaBuildLaunchArgs(static_cast<int>(argv.size()), argv.data(), data, home, background, &storage,
                                         out.data());
  return std::vector<std::string>(out.begin(), out.begin() + count);
}

bool Has(const std::vector<std::string>& args, const std::string& value) {
  for (const std::string& arg : args) {
    if (arg == value) return true;
  }
  return false;
}

}

TEST(background_environment_alone_adds_the_switch) {
  const auto args = Build({"Ardia"}, nullptr, "1");
  CHECK(Has(args, "--ardia-background"));
  CHECK(Has(Build({"Ardia"}, nullptr, "true"), "--ardia-background"));
}

TEST(background_is_not_added_twice_or_for_other_values) {
  const auto twice = Build({"Ardia", "--ardia-background"}, nullptr, "1");
  int count = 0;
  for (const std::string& arg : twice) count += arg == "--ardia-background";
  CHECK(count == 1);
  for (const char* value : {"", "0", "false", "yes", "TRUE"}) {
    CHECK(!Has(Build({"Ardia"}, nullptr, value), "--ardia-background"));
  }
  CHECK(!Has(Build({"Ardia"}, nullptr, nullptr), "--ardia-background"));
}

TEST(child_processes_are_left_alone) {
  const auto args = Build({"Ardia Helper", "--type=renderer"}, "/tmp/data", "1");
  CHECK(args.size() == 2);
}

TEST(data_dir_adds_profile_switches_and_the_shell) {
  const auto args = Build({"Ardia"}, "/tmp/data", nullptr);
  CHECK(Has(args, "--user-data-dir=/tmp/data/Chromium"));
  CHECK(Has(args, "--ardia-data-dir=/tmp/data"));
  CHECK(Has(args, "--use-mock-keychain"));
  CHECK(Has(args, "--ardia-shell=webui"));
  CHECK(!Has(Build({"Ardia", "--ardia-shell=native"}, "/tmp/data", nullptr), "--ardia-shell=webui"));
  CHECK(!Has(Build({"Ardia", "--user-data-dir=/x"}, "/tmp/data", nullptr), "--ardia-data-dir=/tmp/data"));
}

TEST(missing_data_dir_falls_back_to_the_dev_profile) {
  const std::string dev = "/Users/tester/Library/Application Support/Ardia WebUI Dev";
  for (const char* data : {static_cast<const char*>(nullptr), ""}) {
    const auto args = Build({"Ardia"}, data, nullptr);
    CHECK(Has(args, "--user-data-dir=" + dev + "/Chromium"));
    CHECK(Has(args, "--ardia-data-dir=" + dev));
    CHECK(Has(args, "--use-mock-keychain"));
    CHECK(Has(args, "--ardia-shell=webui"));
    for (const std::string& arg : args) CHECK(arg.find("com.ardia.browser") == std::string::npos);
  }
}

TEST(the_shell_is_always_webui_unless_asked) {
  CHECK(Has(Build({"Ardia", "--user-data-dir=/x"}, nullptr, nullptr), "--ardia-shell=webui"));
  CHECK(Has(Build({"Ardia"}, nullptr, nullptr, nullptr), "--ardia-shell=webui"));
  CHECK(!Has(Build({"Ardia", "--ardia-shell=native"}, nullptr, nullptr), "--ardia-shell=webui"));
  CHECK(!Has(Build({"Ardia Helper", "--type=gpu-process"}, nullptr, nullptr), "--ardia-shell=webui"));
}

TEST(injected_switches_stay_before_the_argument_terminator) {
  const auto args = Build({"Ardia", "--enable-logging", "--", "https://example.com", "--user-data-dir=/x"}, nullptr, "1");
  std::size_t terminator = args.size();
  for (std::size_t i = 0; i < args.size(); ++i) {
    if (args[i] == "--") terminator = i;
  }
  CHECK(terminator < args.size());
  CHECK(args[terminator + 1] == "https://example.com");
  CHECK(args[terminator + 2] == "--user-data-dir=/x");
  CHECK(args.size() == terminator + 3);
  for (const char* injected : {"--ardia-shell=webui", "--use-mock-keychain", "--ardia-background"}) {
    bool before = false;
    for (std::size_t i = 0; i < terminator; ++i) before = before || args[i] == injected;
    CHECK(before);
  }
  bool profile = false;
  for (std::size_t i = 0; i < terminator; ++i) profile = profile || args[i].starts_with("--user-data-dir=/Users/tester/");
  CHECK(profile);
  const auto helper = Build({"Ardia Helper", "--type=renderer", "--", "x"}, nullptr, nullptr);
  CHECK(helper.size() == 4 && helper[2] == "--" && helper[3] == "x");
}

TEST(hostile_sinks) {
  const std::string huge(10000, 'a');
  const auto args = Build({"Ardia"}, huge.c_str(), "1");
  CHECK(Has(args, "--ardia-data-dir=/Users/tester/Library/Application Support/Ardia WebUI Dev"));
  CHECK(Has(args, "--ardia-background"));
  const auto nowhere = Build({"Ardia"}, "", nullptr, "");
  CHECK(!Has(nowhere, "--use-mock-keychain"));
  CHECK(Has(nowhere, "--ardia-shell=webui"));
  CHECK(!Has(Build({"Ardia"}, nullptr, nullptr, "relative/home"), "--use-mock-keychain"));
  CHECK(!Has(Build({"Ardia"}, nullptr, nullptr, huge.c_str()), "--use-mock-keychain"));
  const auto all = Build({"Ardia"}, "/tmp/d", "1");
  CHECK(all.size() <= 1 + static_cast<std::size_t>(kArdiaLaunchExtraArgs));
  const auto most = Build({"Ardia"}, nullptr, "1");
  CHECK(most.size() <= 1 + static_cast<std::size_t>(kArdiaLaunchExtraArgs));
}

int main(int argc, char** argv) {
  return ardia_mac_test::RunAll(argc, argv);
}
