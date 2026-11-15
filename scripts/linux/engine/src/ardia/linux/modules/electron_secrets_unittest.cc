// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/electron_secrets.h"

#include "base/base64.h"
#include "base/strings/strcat.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

std::string Entry(std::string_view backend, bool sealed, std::string_view bytes) {
  return base::StrCat({"{\"backend\":\"", backend, "\",\"sealed\":",
                       sealed ? "true" : "false", ",\"value\":\"",
                       base::Base64Encode(bytes), "\"}"});
}

TEST(ElectronSecretsTest, BasicAndPlainSecretsOpenWithoutAKeyring) {
  const std::string json = base::StrCat(
      {"{\"basic\":", Entry("basic_text", true, SealLikeElectron("one", "v10", "peanuts")),
       ",\"plain\":", Entry("basic_text", false, "two"),
       ",\"ring\":", Entry("gnome_libsecret", true, SealLikeElectron("three", "v11", "hunter2")),
       ",\"broken\":{\"backend\":\"x\"}}"});
  auto secrets = ParseElectronSecrets(json);
  ASSERT_EQ(secrets.size(), 3u);
  EXPECT_EQ(OpenElectronSecret(secrets["basic"], std::nullopt), "one");
  EXPECT_EQ(OpenElectronSecret(secrets["plain"], std::nullopt), "two");
  EXPECT_FALSE(NeedsKeyringPassword(secrets["basic"]));
  EXPECT_TRUE(NeedsKeyringPassword(secrets["ring"]));
  EXPECT_EQ(OpenElectronSecret(secrets["ring"], std::nullopt), std::nullopt);
  EXPECT_EQ(OpenElectronSecret(secrets["ring"], "wrong"), std::nullopt);
  EXPECT_EQ(OpenElectronSecret(secrets["ring"], "hunter2"), "three");
}

TEST(ElectronSecretsTest, TheBasicKeyIsChromesV10Key) {
  const std::string sealed = SealLikeElectron("peanut butter", "v10", "peanuts");
  EXPECT_EQ(sealed.substr(0, 3), "v10");
  EXPECT_EQ(sealed.size(), 3u + 16u);
  EXPECT_TRUE(ParseElectronSecrets("not json").empty());
}

}

}
