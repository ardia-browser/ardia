// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/import/browser_icons.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux::import {

namespace {

base::FilePath Touch(const base::FilePath& path) {
  EXPECT_TRUE(base::CreateDirectory(path.DirName()));
  EXPECT_TRUE(base::WriteFile(path, "icon"));
  return path;
}

class BrowserIconsTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(home_.CreateUniqueTempDir());
    ASSERT_TRUE(system_.CreateUniqueTempDir());
  }

  std::optional<base::FilePath> Find(std::vector<std::string> names) {
    return FindBrowserIcon(home_.GetPath(), system_.GetPath(), names);
  }

  base::ScopedTempDir home_;
  base::ScopedTempDir system_;
};

}

TEST_F(BrowserIconsTest, TheUsersThemeComesFirstAtTheFirstSizeFound) {
  Touch(system_.GetPath().Append("usr/share/icons/hicolor/128x128/apps/firefox.png"));
  const base::FilePath mine = Touch(
      home_.GetPath().Append(".local/share/icons/hicolor/256x256/apps/firefox.png"));
  EXPECT_EQ(Find({"firefox"}), mine);
}

TEST_F(BrowserIconsTest, EachNameIsTriedInOrderThenPixmapsThenSnaps) {
  const base::FilePath second = Touch(
      system_.GetPath().Append("usr/share/icons/hicolor/scalable/apps/chromium-browser.svg"));
  EXPECT_EQ(Find({"chromium", "chromium-browser"}), second);
  const base::FilePath pixmap =
      Touch(system_.GetPath().Append("usr/share/pixmaps/brave.png"));
  EXPECT_EQ(Find({"brave"}), pixmap);
  const base::FilePath snapped = Touch(system_.GetPath().Append("snap/vivaldi/12/icon.png"));
  ASSERT_TRUE(base::CreateDirectory(
      system_.GetPath().Append("var/lib/snapd/desktop/applications")));
  ASSERT_TRUE(base::WriteFile(
      system_.GetPath().Append(
          "var/lib/snapd/desktop/applications/vivaldi_vivaldi.desktop"),
      "[Desktop Entry]\nName=Vivaldi\nIcon=" + snapped.value() + "\n"));
  EXPECT_EQ(Find({"vivaldi"}), snapped);
}

TEST_F(BrowserIconsTest, NamesThatWouldLeaveTheIconFoldersFindNothing) {
  Touch(system_.GetPath().Append("usr/share/icons/hicolor/128x128/secret.png"));
  EXPECT_EQ(Find({"../secret", "", "/etc/passwd", ".."}), std::nullopt);
  EXPECT_EQ(Find({"nothing"}), std::nullopt);
}

TEST_F(BrowserIconsTest, OnlyImagesAreServable) {
  EXPECT_TRUE(IsServableImage(base::FilePath("/a/Google Profile Picture.png")));
  EXPECT_TRUE(IsServableImage(base::FilePath("/a/icon.SVG")));
  EXPECT_FALSE(IsServableImage(base::FilePath("/a/Login Data")));
  EXPECT_FALSE(IsServableImage(base::FilePath("/a/key4.db")));
}

}
