// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/file_drop_rules.h"

#include <string>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

class FileDropRulesTest : public testing::Test {
 protected:
  void SetUp() override { ASSERT_TRUE(scratch_.CreateUniqueTempDir()); }

  base::FilePath Write(std::string_view name, std::string_view contents) {
    base::FilePath path = scratch_.GetPath().Append(name);
    EXPECT_TRUE(base::WriteFile(path, contents));
    return path;
  }

  base::ListValue Items(const std::vector<base::FilePath>& paths,
                        DropAccepts accepts) {
    examined_.clear();
    for (const base::FilePath& path : paths) {
      examined_.push_back(ExamineDroppedPath(path));
    }
    std::vector<const DroppedPath*> pointers;
    for (const DroppedPath& path : examined_) {
      pointers.push_back(&path);
    }
    return DroppedItems(pointers, accepts);
  }

  base::ScopedTempDir scratch_;
  std::vector<DroppedPath> examined_;
};

TEST(DroppedWebUrlTest, OnlyHttpAndHttpsWithAHost) {
  EXPECT_EQ(DroppedWebUrl(" https://example.com/a "), "https://example.com/a");
  EXPECT_FALSE(DroppedWebUrl("file:///etc/passwd"));
  EXPECT_FALSE(DroppedWebUrl("javascript:alert(1)"));
  EXPECT_FALSE(DroppedWebUrl(""));
  EXPECT_FALSE(DroppedWebUrl("https://" + std::string(8200, 'a') + ".com"));
}

TEST(LinkFileTargetTest, ReadsUrlFilesAndPlists) {
  EXPECT_EQ(LinkFileTarget(base::FilePath("/a/b.url"),
                           "[InternetShortcut]\r\nURL=https://example.com/x\r\n"),
            "https://example.com/x");
  EXPECT_EQ(LinkFileTarget(base::FilePath("/a/b.webloc"),
                           "<dict><key>URL</key><string>https://e.com/?a=1&amp;b=2"
                           "</string></dict>"),
            "https://e.com/?a=1&b=2");
  EXPECT_FALSE(LinkFileTarget(base::FilePath("/a/b.url"),
                              "URL=javascript:alert(1)"));
}

TEST_F(FileDropRulesTest, FilesBecomeFileUrlsAndLinkFilesTheirLinks) {
  base::FilePath page = Write("page.html", "<p>");
  base::FilePath link = Write("link.url", "URL=https://example.com/\n");
  base::FilePath bad = Write("bad.webloc", "nothing");
  base::FilePath big = Write("big.url", "URL=https://example.com/\n" +
                                            std::string(70 * 1024, ' '));
  base::ListValue items =
      Items({page, link, bad, big, scratch_.GetPath().Append("gone"),
             base::FilePath("relative.html")},
            DropAccepts::kLinks);
  ASSERT_EQ(items.size(), 2u);
  EXPECT_EQ(*items[0].GetDict().FindString("kind"), "file");
  EXPECT_EQ(*items[0].GetDict().FindString("url"),
            "file://" + page.value());
  EXPECT_EQ(*items[1].GetDict().FindString("url"), "https://example.com/");
}

TEST_F(FileDropRulesTest, ExtensionPackagesAreAllOrNothing) {
  base::FilePath one = Write("one.crx", "x");
  base::FilePath two = Write("two.CRX", "x");
  base::FilePath page = Write("page.html", "x");
  EXPECT_EQ(Items({one, two}, DropAccepts::kExtensionPackages).size(), 2u);
  EXPECT_TRUE(Items({one, page}, DropAccepts::kExtensionPackages).empty());
  EXPECT_TRUE(Items({}, DropAccepts::kExtensionPackages).empty());
}

TEST_F(FileDropRulesTest, AtMostFiftyItems) {
  base::FilePath page = Write("page.html", "x");
  std::vector<base::FilePath> many(60, page);
  EXPECT_EQ(Items(many, DropAccepts::kLinks).size(), kMaxDroppedItems);
  base::FilePath package = Write("p.crx", "x");
  EXPECT_TRUE(Items(std::vector<base::FilePath>(51, package),
                    DropAccepts::kExtensionPackages)
                  .empty());
}

}

}
