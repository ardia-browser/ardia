// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/desktop_entry.h"

#include "base/strings/string_util.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

TEST(DesktopEntryTest, ATestInstanceKeepsItsDesktopInsideItsDataFolder) {
  DesktopPlaces places =
      PlacesFor(base::FilePath("/tmp/scratch"), true,
                base::FilePath("/home/me/.local/share"),
                base::FilePath("/home/me/.config"));
  EXPECT_EQ(places.UserDesktopFile().value(),
            "/tmp/scratch/Desktop/share/applications/ardia.desktop");
  EXPECT_EQ(places.AutostartFile().value(),
            "/tmp/scratch/Desktop/config/autostart/ardia.desktop");
  DesktopPlaces real = PlacesFor(base::FilePath("/home/me/.local/share/ardia"),
                                 false, base::FilePath("/home/me/.local/share"),
                                 base::FilePath("/home/me/.config"));
  EXPECT_EQ(real.MimeAppsFile().value(), "/home/me/.config/mimeapps.list");
}

TEST(DesktopEntryTest, TheEntryQuotesTheLauncherAndHasTheNewWindowAction) {
  const std::string text = DesktopEntryText("/opt/My Apps/ardia");
  EXPECT_NE(text.find("Exec=\"/opt/My Apps/ardia\" %U\n"), std::string::npos);
  EXPECT_NE(text.find("StartupWMClass=ardia\n"), std::string::npos);
  EXPECT_NE(text.find("Exec=\"/opt/My Apps/ardia\" --new-window"),
            std::string::npos);
  EXPECT_EQ(QuotedExec("/opt/ardia/ardia"), "/opt/ardia/ardia");
  EXPECT_EQ(QuotedExec("/a/$b"), "\"/a/\\$b\"");
  const std::string autostart = AutostartEntryText("/opt/ardia/ardia");
  EXPECT_NE(autostart.find("Exec=/opt/ardia/ardia --autostart\n"),
            std::string::npos);
  EXPECT_NE(autostart.find("X-Ardia-Autostart=true"), std::string::npos);
}

TEST(DesktopEntryTest, DefaultApplicationsReplaceOnlyTheirOwnLines) {
  const std::string existing =
      "[Added Associations]\nimage/png=eog.desktop;\n\n"
      "[Default Applications]\nx-scheme-handler/http=firefox.desktop\n"
      "image/png=eog.desktop\n\n[Removed Associations]\nfoo=bar\n";
  const std::string updated = WithDefaultApplications(
      existing, "ardia.desktop",
      {"x-scheme-handler/http", "x-scheme-handler/https"});
  EXPECT_EQ(updated,
            "[Added Associations]\nimage/png=eog.desktop;\n\n"
            "[Default Applications]\nx-scheme-handler/http=ardia.desktop\n"
            "x-scheme-handler/https=ardia.desktop\nimage/png=eog.desktop\n\n"
            "[Removed Associations]\nfoo=bar\n");
  EXPECT_EQ(DefaultApplicationIn(updated, "x-scheme-handler/https"),
            "ardia.desktop");
  EXPECT_EQ(DefaultApplicationIn(updated, "foo"), std::nullopt);
  EXPECT_EQ(WithDefaultApplications("", "ardia.desktop", {"text/html"}),
            "[Default Applications]\ntext/html=ardia.desktop\n");
}

TEST(DesktopEntryTest, ToolsRunWithADeadline) {
  ToolRun echo = RunTool({"/bin/echo", "hello"}, base::Seconds(5));
  EXPECT_TRUE(echo.ok);
  EXPECT_EQ(echo.out, "hello");
  ToolRun slow = RunTool({"/bin/sleep", "5"}, base::Milliseconds(100));
  EXPECT_FALSE(slow.ok);
  EXPECT_TRUE(slow.timed_out);
  ToolRun missing = RunTool({"/nonexistent/tool"}, base::Seconds(1));
  EXPECT_FALSE(missing.ok);
}

}

}
