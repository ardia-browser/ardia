// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/test_gate.h"

#include <unistd.h>

#include <string>
#include <string_view>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

class ScratchProfileTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(scratch_.CreateUniqueTempDir());
    ASSERT_TRUE(real_.CreateUniqueTempDir());
    data_ = scratch_.GetPath().Append("data");
    chromium_ = data_.Append("Chromium");
    ASSERT_TRUE(base::CreateDirectory(chromium_));
    ASSERT_TRUE(base::CreateDirectory(Real("Default")));
    ASSERT_TRUE(base::WriteFile(Real("Default/Cookies"), "real cookies"));
    ASSERT_TRUE(base::WriteFile(Real("Local State"), "{}"));
  }

  base::FilePath Real(std::string_view name) {
    return real_.GetPath().Append(name);
  }

  base::FilePath Scratch(std::string_view name) {
    return chromium_.Append(name);
  }

  void Link(const base::FilePath& target, const base::FilePath& link) {
    ASSERT_TRUE(base::CreateDirectory(link.DirName()));
    ASSERT_TRUE(base::CreateSymbolicLink(target, link));
  }

  void WriteLocalState(std::string_view json) {
    ASSERT_TRUE(base::WriteFile(Scratch("Local State"), json));
  }

  void MakeOwnProfile(std::string_view name) {
    ASSERT_TRUE(base::CreateDirectory(Scratch(name)));
    ASSERT_TRUE(base::WriteFile(Scratch(name).Append("Preferences"), "{}"));
  }

  base::ScopedTempDir scratch_;
  base::ScopedTempDir real_;
  base::FilePath data_;
  base::FilePath chromium_;
};

TEST_F(ScratchProfileTest, AnEmptyScratchFolderIsHeld) {
  EXPECT_EQ(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, ChromesOwnLinksAndProfilesInsideAreHeld) {
  MakeOwnProfile("Default");
  MakeOwnProfile("Profile 1");
  Link(base::FilePath("Preferences"), Scratch("Default/Linked Preferences"));
  Link(Scratch("Profile 1"), Scratch("Profile 1 Alias"));
  Link(base::FilePath("ardia-test-4242"), Scratch("SingletonLock"));
  Link(base::FilePath("/tmp/.org.chromium.Chromium.x/SingletonSocket"),
       Scratch("SingletonSocket"));
  Link(base::FilePath("/tmp/.org.chromium.Chromium.x/SingletonCookie"),
       Scratch("SingletonCookie"));
  WriteLocalState(R"({"profile": {
    "info_cache": {"Default": {}, "Profile 1": {}, "Profile 2": {}},
    "last_used": "Profile 1",
    "last_active_profiles": ["Default", "Profile 1"],
    "profiles_order": ["Default", "Profile 1"]}})");
  EXPECT_EQ(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, ADefaultLinkedToTheRealProfileIsRefused) {
  Link(Real("Default"), Scratch("Default"));
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, AnotherProfileLinkedToTheRealProfileIsRefused) {
  MakeOwnProfile("Default");
  Link(Real("Default"), Scratch("Profile 3"));
  WriteLocalState(R"({"profile": {"info_cache": {"Profile 3": {}}}})");
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, ALinkedLocalStateIsRefused) {
  Link(Real("Local State"), Scratch("Local State"));
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, AProfileFileLinkedOutIsRefused) {
  MakeOwnProfile("Default");
  Link(Real("Default/Cookies"), Scratch("Default/Cookies"));
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, ADanglingLinkOutIsRefused) {
  Link(Real("Profile 9"), Scratch("Profile 9"));
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, ALinkClimbingPastAMissingFolderIsRefused) {
  Link(base::FilePath("missing/../../../../real/Default"), Scratch("Default"));
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, AProfileLinkedBesideTheChromiumFolderIsRefused) {
  ASSERT_TRUE(base::CreateDirectory(data_.Append("elsewhere")));
  Link(Real("Default/Cookies"), data_.Append("elsewhere/Cookies"));
  Link(data_.Append("elsewhere"), Scratch("Default"));
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, AHardLinkedProfileFileIsRefused) {
  MakeOwnProfile("Default");
  ASSERT_EQ(link(Real("Default/Cookies").value().c_str(),
                 Scratch("Default/Cookies").value().c_str()),
            0);
  EXPECT_NE(HoldScratchFolders(data_), "");
}

TEST_F(ScratchProfileTest, ALocalStateNamingAProfileOutsideIsRefused) {
  for (const char* json : {
           R"({"profile": {"info_cache": {"../../real/Default": {}}}})",
           R"({"profile": {"last_used": "../Default"}})",
           R"({"profile": {"last_active_profiles": ["/home/owner/Default"]}})",
           R"({"profile": {"profiles_order": [".."]}})",
       }) {
    WriteLocalState(json);
    EXPECT_NE(HoldScratchFolders(data_), "") << json;
  }
}

TEST_F(ScratchProfileTest, AnUnreadableLocalStateIsRefused) {
  WriteLocalState("{\"profile\": ");
  EXPECT_NE(HoldScratchFolders(data_), "");
}

}

}
