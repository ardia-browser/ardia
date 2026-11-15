// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/launch_config.h"

#include "base/command_line.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

base::CommandLine LaunchedWith(std::vector<std::string> switches) {
  std::vector<std::string> argv = {"ardia"};
  argv.insert(argv.end(), switches.begin(), switches.end());
  return base::CommandLine(argv);
}

TEST(LaunchConfigTest, KeyedEntriesKeepCommasInsideValuesThatHoldThem) {
  std::vector<std::string> unknown;
  KeyedEntries entries = ParseKeyedEntries(
      "keychain=fake,liveMock=a,b,c,appMenu,nonsense=1",
      {"keychain", "liveMock", "appMenu"}, {"liveMock"}, &unknown);
  EXPECT_EQ(entries["keychain"], "fake");
  EXPECT_EQ(entries["liveMock"], "a,b,c");
  EXPECT_EQ(entries["appMenu"], "1");
  EXPECT_FALSE(entries.contains("nonsense"));
  ASSERT_EQ(unknown.size(), 1u);
  EXPECT_EQ(unknown[0], "nonsense");
}

TEST(LaunchConfigTest, SwitchEntriesReadOnAndOff) {
  auto entries = ParseSwitchEntries("a=on, b = 0,c=maybe,d,e=true");
  EXPECT_TRUE(entries["a"]);
  EXPECT_FALSE(entries["b"]);
  EXPECT_FALSE(entries.contains("c"));
  EXPECT_FALSE(entries.contains("d"));
  EXPECT_TRUE(entries["e"]);
}

TEST(LaunchConfigTest, ATestInstanceKeepsItsTestKeys) {
  const LaunchConfig config = ReadLaunchConfig(
      LaunchedWith({"--ardia-data-dir=/tmp/scratch", "--ardia-test-instance",
                    "--ardia-background", "--ardia-test=appMenu,keychain=x",
                    "--ardia-trace=keys,bogus,keys", "--ardia-updatefeed=u",
                    "--ardia-jslocation=/js", "--ardia-feedback-url=http://f"}),
      base::FilePath("/home/me/.config"));
  EXPECT_EQ(config.config_directory.value(), "/tmp/scratch/config");
  EXPECT_TRUE(config.background);
  EXPECT_TRUE(config.TestFlag("appMenu"));
  EXPECT_EQ(config.TestValue("keychain"), "x");
  ASSERT_EQ(config.trace.size(), 1u);
  EXPECT_EQ(config.trace[0], "keys");
  EXPECT_EQ(config.instance.at("updateFeed"), "u");
  EXPECT_EQ(config.instance.at("jsLocation"), "/js");
  const base::DictValue value = config.ToValue();
  EXPECT_EQ(*value.FindString("dataDirectory"), "/tmp/scratch");
  EXPECT_EQ(*value.FindBool("isolated"), true);
  EXPECT_EQ(*value.FindString("feedbackURL"), "http://f");
}

TEST(LaunchConfigTest, OutsideATestInstanceTestKeysAndTestOnlyInstanceKeysGo) {
  const LaunchConfig config = ReadLaunchConfig(
      LaunchedWith({"--ardia-test=appMenu", "--ardia-trace=keys",
                    "--ardia-updatefeed=u", "--ardia-releasenotes=1"}),
      base::FilePath("/home/me/.config"));
  EXPECT_EQ(config.config_directory.value(), "/home/me/.config/ardia");
  EXPECT_TRUE(config.test.empty());
  EXPECT_TRUE(config.trace.empty());
  EXPECT_FALSE(config.instance.contains("updateFeed"));
  EXPECT_TRUE(config.InstanceFlag("releaseNotes"));
  const base::DictValue value = config.ToValue();
  EXPECT_TRUE(value.Find("dataDirectory")->is_none());
  EXPECT_EQ(*value.FindBool("isolated"), false);
}

}

}
