// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/import/import_core.h"

#include <string>

#include "base/base64.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/json/json_reader.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/boringssl/src/include/openssl/cipher.h"
#include "third_party/boringssl/src/include/openssl/evp.h"

namespace ardia_linux::import {

namespace {

base::FilePath Firefox() {
  base::FilePath fixtures =
      base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(
          "import-fixtures");
  return fixtures.empty()
             ? fixtures
             : fixtures.Append("home/Library/Application Support/Firefox/Profiles");
}

std::string Encrypt(std::string_view password, std::string_view plain) {
  std::string key(16, '\0');
  PKCS5_PBKDF2_HMAC_SHA1(password.data(), password.size(),
                         reinterpret_cast<const uint8_t*>("saltysalt"), 9, 1,
                         16, reinterpret_cast<uint8_t*>(key.data()));
  const std::string iv(16, ' ');
  bssl::ScopedEVP_CIPHER_CTX context;
  EVP_EncryptInit_ex(context.get(), EVP_aes_128_cbc(), nullptr,
                     reinterpret_cast<const uint8_t*>(key.data()),
                     reinterpret_cast<const uint8_t*>(iv.data()));
  std::string out(plain.size() + 16, '\0');
  int written = 0;
  int last = 0;
  EVP_EncryptUpdate(context.get(), reinterpret_cast<uint8_t*>(out.data()),
                    &written, reinterpret_cast<const uint8_t*>(plain.data()),
                    plain.size());
  EVP_EncryptFinal_ex(context.get(),
                      reinterpret_cast<uint8_t*>(out.data()) + written, &last);
  out.resize(written + last);
  return out;
}

TEST(ImportCoreTest, ChromiumBlobsOpenWithTheBuiltInOrKeyringKey) {
  ChromiumKeys keys = KeysFromPassword(std::string("from the keyring"));
  Decrypted basic =
      DecryptChromium("v10" + Encrypt("peanuts", "hunter2"), keys);
  ASSERT_TRUE(basic.value);
  EXPECT_EQ(basic.value->str(), "hunter2");
  Decrypted keyring =
      DecryptChromium("v11" + Encrypt("from the keyring", "s3cret"), keys);
  ASSERT_TRUE(keyring.value);
  EXPECT_EQ(keyring.value->str(), "s3cret");
  EXPECT_EQ(DecryptChromium("v11" + Encrypt("other", "x"), keys).reason,
            Undecrypted::kUndecryptable);
  EXPECT_EQ(DecryptChromium("v20whatever", keys).reason,
            Undecrypted::kAppBound);
  EXPECT_EQ(DecryptChromium("plain", keys).value->str(), "plain");
  EXPECT_TRUE(DecryptChromium("", keys).value->str().empty());
}

TEST(ImportCoreTest, ReadsStayInsideTheRoot) {
  base::ScopedTempDir root;
  ASSERT_TRUE(root.CreateUniqueTempDir());
  base::FilePath home = base::MakeAbsoluteFilePath(root.GetPath());
  base::FilePath inside = home.Append("profile");
  ASSERT_TRUE(base::CreateDirectory(inside));
  ASSERT_TRUE(base::WriteFile(inside.Append("Bookmarks"), "{}"));
  base::ScopedTempDir outside;
  ASSERT_TRUE(outside.CreateUniqueTempDir());
  ASSERT_TRUE(base::CreateSymbolicLink(outside.GetPath(), home.Append("link")));
  EXPECT_TRUE(ConfinedPath(home, inside.Append("Bookmarks").value()));
  EXPECT_FALSE(ConfinedPath(home, "/etc/passwd"));
  EXPECT_FALSE(ConfinedPath(home, inside.value() + "/../../etc"));
  EXPECT_FALSE(ConfinedPath(home, home.Append("link").value()));
  EXPECT_FALSE(ConfinedPath(home, "relative"));
  EXPECT_TRUE(ConfinedWithin(home, inside.value(), "Bookmarks"));
  EXPECT_FALSE(ConfinedWithin(home, inside.value(), "../profile/Bookmarks"));
  EXPECT_FALSE(ConfinedWithin(home, inside.value(), "/etc/passwd"));
}

TEST(ImportCoreTest, SnapshotsAnswerSelectsAndRefuseEverythingElse) {
  base::ScopedTempDir root;
  ASSERT_TRUE(root.CreateUniqueTempDir());
  base::FilePath other = root.GetPath().Append("other.db");
  {
    std::string failure;
    base::FilePath source = root.GetPath().Append("source.db");
    ASSERT_TRUE(base::WriteFile(source, ""));
  }
  std::string failure;
  EXPECT_FALSE(Snapshot::Open(root.GetPath().Append("missing.db"), &failure));
  EXPECT_EQ(failure, "missing");
  base::FilePath places = Firefox().empty()
                              ? base::FilePath()
                              : Firefox().Append("abcd1234.default-release")
                                    .Append("places.sqlite");
  if (places.empty()) {
    GTEST_SKIP();
  }
  std::unique_ptr<Snapshot> snapshot = Snapshot::Open(places, &failure);
  ASSERT_TRUE(snapshot) << failure;
  base::ListValue queries;
  queries.Append(base::DictValue().Set(
      "sql", "SELECT url FROM moz_places WHERE url LIKE ? ORDER BY id"));
  queries.back().GetDict().Set("args", base::ListValue().Append("http%"));
  queries.Append(base::DictValue().Set(
      "sql", "ATTACH '" + other.value() + "' AS other"));
  queries.Append(base::DictValue().Set("sql", "DELETE FROM moz_places"));
  base::DictValue answer = snapshot->Run(queries);
  const base::ListValue& results = *answer.FindList("results");
  ASSERT_EQ(results.size(), 3u);
  EXPECT_GT(results[0].GetDict().FindList("rows")->size(), 0u);
  EXPECT_EQ(*results[0].GetDict().FindList("columns"),
            base::ListValue().Append("url"));
  EXPECT_TRUE(results[1].GetDict().FindString("error"));
  EXPECT_TRUE(results[2].GetDict().FindString("error"));
  EXPECT_FALSE(base::PathExists(other));
}

TEST(ImportCoreTest, FirefoxPasswordsOpenAndThePrimaryPasswordUnlocksWork) {
  if (Firefox().empty()) {
    GTEST_SKIP() << "run with --import-fixtures=<packages/import/fixtures>";
  }
  std::string failure;
  std::unique_ptr<Snapshot> plain = Snapshot::Open(
      Firefox().Append("abcd1234.default-release").Append("key4.db"), &failure);
  ASSERT_TRUE(plain);
  FirefoxKey key = FirefoxKeyFrom(*plain, "");
  ASSERT_TRUE(key.key) << key.error;
  std::string json;
  ASSERT_TRUE(base::ReadFileToString(
      Firefox().Append("abcd1234.default-release").Append("logins.json"),
      &json));
  std::optional<base::Value> logins = base::JSONReader::Read(json, 0);
  int opened = 0;
  for (const base::Value& login : *logins->GetDict().FindList("logins")) {
    if (DecryptLoginField(*login.GetDict().FindString("encryptedPassword"),
                          *key.key)) {
      ++opened;
    }
  }
  EXPECT_EQ(opened, 2);

  std::unique_ptr<Snapshot> work = Snapshot::Open(
      Firefox().Append("zzzz9999.work").Append("key4.db"), &failure);
  ASSERT_TRUE(work);
  EXPECT_TRUE(FirefoxKeyFrom(*work, "").locked);
  FirefoxKey unlocked = FirefoxKeyFrom(*work, "hunter2");
  ASSERT_TRUE(unlocked.key) << unlocked.error;
  ASSERT_TRUE(base::ReadFileToString(
      Firefox().Append("zzzz9999.work").Append("logins.json"), &json));
  logins = base::JSONReader::Read(json, 0);
  std::optional<SecretText> password = DecryptLoginField(
      *(*logins->GetDict().FindList("logins"))[0].GetDict().FindString(
          "encryptedPassword"),
      *unlocked.key);
  ASSERT_TRUE(password);
  EXPECT_EQ(password->str(), "aes-protected");
}

}

}
