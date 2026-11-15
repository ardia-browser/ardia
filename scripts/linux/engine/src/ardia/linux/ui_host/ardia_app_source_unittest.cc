#include "ardia/linux/ui_host/ardia_app_source.h"

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

class ArdiaAppSourceTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    root_ = temp_.GetPath().Append("ui");
    ASSERT_TRUE(base::CreateDirectory(root_.Append("assets")));
    ASSERT_TRUE(base::WriteFile(root_.Append("index.html"), "<!doctype html>"));
    ASSERT_TRUE(base::WriteFile(root_.Append("assets/app.js"), "1"));
    ASSERT_TRUE(base::WriteFile(temp_.GetPath().Append("secret"), "no"));
  }

  base::ScopedTempDir temp_;
  base::FilePath root_;
};

TEST_F(ArdiaAppSourceTest, ServesFilesInsideTheFolder) {
  EXPECT_TRUE(ConfinedPath(root_, "index.html"));
  EXPECT_TRUE(ConfinedPath(root_, "assets/app.js"));
}

TEST_F(ArdiaAppSourceTest, RefusesEverythingOutsideIt) {
  EXPECT_FALSE(ConfinedPath(root_, "../secret"));
  EXPECT_FALSE(ConfinedPath(root_, "assets/../../secret"));
  EXPECT_FALSE(ConfinedPath(root_, "/etc/passwd"));
  EXPECT_FALSE(ConfinedPath(root_, ""));
  EXPECT_FALSE(ConfinedPath(root_, "assets"));
  EXPECT_FALSE(ConfinedPath(root_, "missing.js"));
  EXPECT_FALSE(ConfinedPath(root_, std::string_view("index.html\0x", 12)));
}

TEST_F(ArdiaAppSourceTest, RefusesSymlinksThatLeave) {
  ASSERT_TRUE(base::CreateSymbolicLink(temp_.GetPath().Append("secret"),
                                       root_.Append("link")));
  EXPECT_FALSE(ConfinedPath(root_, "link"));
}

TEST(ArdiaAppPolicyTest, TakesOnlyWellFormedScriptHashes) {
  std::vector<std::string> hashes = ScriptHashesFromJson(
      R"({"scriptSrc": ["'sha256-wyHw8EHIFZPNCzHjI2oBo3LWCdc6ZFJ1ROnvtK9YNak='",
                        "'unsafe-inline'", "'sha256-x'; script-src *",
                        "https://example.com", 7]})");
  ASSERT_EQ(hashes.size(), 1u);
  EXPECT_EQ(ScriptSrc(hashes),
            "script-src 'self' 'wasm-unsafe-eval' "
            "'sha256-wyHw8EHIFZPNCzHjI2oBo3LWCdc6ZFJ1ROnvtK9YNak=';");
  EXPECT_TRUE(ScriptHashesFromJson("not json").empty());
  EXPECT_EQ(ScriptSrc({}), "script-src 'self' 'wasm-unsafe-eval';");
}

TEST(ArdiaAppMimeTypeTest, KnowsTheBundlesTypes) {
  EXPECT_EQ(MimeTypeForPath(""), "text/html");
  EXPECT_EQ(MimeTypeForPath("index.html"), "text/html");
  EXPECT_EQ(MimeTypeForPath("assets/index-1.js"), "text/javascript");
  EXPECT_EQ(MimeTypeForPath("assets/bergamot.wasm"), "application/wasm");
  EXPECT_EQ(MimeTypeForPath("assets/a.PNG?v=1"), "image/png");
  EXPECT_EQ(MimeTypeForPath("assets.d/file"), "application/octet-stream");
}

}
