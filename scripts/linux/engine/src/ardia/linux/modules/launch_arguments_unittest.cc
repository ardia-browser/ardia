// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/launch_arguments.h"

#include <set>

#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

TEST(LaunchArgumentsTest, ExistingPathsBecomeFileUrlsAndTheRestStaysText) {
  const std::set<std::string> on_disk = {"/home/me/page.html",
                                         "/home/me/docs/a b.pdf",
                                         "/home/me/example.com"};
  auto exists = [&](const base::FilePath& path) {
    return on_disk.contains(path.value());
  };
  const base::FilePath cwd("/home/me");
  EXPECT_EQ(LaunchArgumentText("page.html", cwd, exists),
            "file:///home/me/page.html");
  EXPECT_EQ(LaunchArgumentText("docs/a b.pdf", cwd, exists),
            "file:///home/me/docs/a%20b.pdf");
  EXPECT_EQ(LaunchArgumentText("/home/me/page.html", cwd, exists),
            "file:///home/me/page.html");
  EXPECT_EQ(LaunchArgumentText("example.com", cwd, exists), "example.com");
  EXPECT_EQ(LaunchArgumentText("./example.com", cwd, exists),
            "file:///home/me/example.com");
  EXPECT_EQ(LaunchArgumentText("https://ardia.dev/x", cwd, exists),
            "https://ardia.dev/x");
  EXPECT_EQ(LaunchArgumentText("missing.html", cwd, exists), "missing.html");
  EXPECT_EQ(LaunchArgumentText("  ", cwd, exists), "");
}

}

}
