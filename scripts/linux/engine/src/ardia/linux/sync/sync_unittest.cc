// Copyright 2026 Ardia. Apache-2.0.

#include <set>
#include <string>
#include <vector>

#include "ardia/linux/sync/sync_crypto.h"
#include "ardia/linux/sync/sync_logins.h"
#include "ardia/linux/sync/sync_phrase.h"
#include "ardia/linux/sync/sync_vault.h"
#include "base/command_line.h"
#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/json/json_reader.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux::sync {

namespace {

constexpr const char* kSides[] = {"mac", "windows"};

base::FilePath Fixtures() {
  return base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(
      "sync-fixtures");
}

std::string Bytes(std::string_view hex) {
  std::string out;
  EXPECT_TRUE(base::HexStringToString(hex, &out));
  return out;
}

base::DictValue Manifest(std::string_view side) {
  std::string text;
  EXPECT_TRUE(base::ReadFileToString(
      Fixtures().AppendASCII(std::string(side) + ".json"), &text));
  std::optional<base::Value> parsed = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  EXPECT_TRUE(parsed && parsed->is_dict());
  return parsed ? std::move(parsed->GetDict()) : base::DictValue();
}

std::vector<std::string> Strings(const base::ListValue* list) {
  std::vector<std::string> out;
  for (const base::Value& value : *list) {
    out.push_back(value.GetString());
  }
  return out;
}

base::Value Json(std::string_view text) {
  std::optional<base::Value> parsed = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  EXPECT_TRUE(parsed) << text;
  return parsed ? std::move(*parsed) : base::Value();
}

Keys KeysOf(std::string_view entropy) {
  std::optional<Keys> keys = Keys::Derive(entropy);
  CHECK(keys);
  return std::move(*keys);
}

class SyncFixturesTest : public testing::Test {
 protected:
  void SetUp() override {
    if (Fixtures().empty()) {
      GTEST_SKIP() << "run with --sync-fixtures=<packages/sync/tests/fixtures/"
                      "windows-interop>";
    }
  }
};

TEST_F(SyncFixturesTest, KeysTagsAndThePhraseMatchTheMacAndWindows) {
  for (const char* side : kSides) {
    base::DictValue m = Manifest(side);
    const std::string entropy = Bytes(*m.FindString("entropy"));
    Keys keys = KeysOf(entropy);
    EXPECT_EQ(keys.chain_tag(), *m.FindString("chainTag"));
    for (auto [scope, tag] : *m.FindDict("scopeTags")) {
      EXPECT_EQ(keys.ScopeTag(scope), tag.GetString());
    }
    std::vector<std::string> words = Strings(m.FindList("words"));
    EXPECT_EQ(*WordsFor(entropy), words);
    auto parsed = EntropyFrom(base::JoinString(words, " "));
    ASSERT_TRUE(std::holds_alternative<Secret>(parsed));
    EXPECT_EQ(std::get<Secret>(parsed).str(), entropy);
    std::vector<std::string> sloppy;
    for (size_t i = 0; i < words.size(); ++i) {
      sloppy.push_back(i % 2 ? base::ToUpperASCII(words[i])
                             : words[i].substr(
                                   0, std::max<size_t>(4, words[i].size() - 1)));
    }
    auto loose = EntropyFrom("  " + base::JoinString(sloppy, ",\n") + " ");
    ASSERT_TRUE(std::holds_alternative<Secret>(loose));
    EXPECT_EQ(std::get<Secret>(loose).str(), entropy);
  }
}

TEST(SyncPhraseTest, ProblemsAreReportedLikeTheMac) {
  std::vector<std::string> words = *WordsFor(std::string(32, '\x07'));
  auto short_phrase = EntropyFrom(
      base::JoinString(std::vector<std::string>(words.begin() + 1, words.end()),
                       " "));
  ASSERT_TRUE(std::holds_alternative<PhraseProblem>(short_phrase));
  EXPECT_EQ(std::get<PhraseProblem>(short_phrase).error, "wordCount");
  EXPECT_EQ(std::get<PhraseProblem>(short_phrase).count, 23u);
  std::vector<std::string> unknown = words;
  unknown[0] = "zzzz";
  auto unknown_word = EntropyFrom(base::JoinString(unknown, " "));
  ASSERT_TRUE(std::holds_alternative<PhraseProblem>(unknown_word));
  EXPECT_EQ(std::get<PhraseProblem>(unknown_word).word, "zzzz");
  std::vector<std::string> wrong = words;
  wrong[23] = words[23] == "abandon" ? "ability" : "abandon";
  auto checksum = EntropyFrom(base::JoinString(wrong, " "));
  ASSERT_TRUE(std::holds_alternative<PhraseProblem>(checksum));
  EXPECT_EQ(std::get<PhraseProblem>(checksum).error, "checksum");
}

TEST_F(SyncFixturesTest, LinuxOpensTheVaultsTheMacAndWindowsWrote) {
  for (const char* side : kSides) {
    base::DictValue m = Manifest(side);
    Keys keys = KeysOf(Bytes(*m.FindString("entropy")));
    auto vault = Vault::At(Fixtures().AppendASCII(side).value(), keys);
    ASSERT_TRUE(vault.has_value());
    EXPECT_EQ(vault->ChainStatus(), "ok");
    for (const base::Value& file : *m.FindList("files")) {
      const std::string scope = *file.GetDict().FindString("scope");
      const std::string id = *file.GetDict().FindString("id");
      auto listing = vault->Read(scope, {}, base::Time::Now());
      ASSERT_TRUE(listing.has_value()) << side;
      EXPECT_TRUE(listing->damaged.empty()) << side << " " << scope;
      ASSERT_EQ(listing->present.size(), 1u);
      EXPECT_EQ(listing->present[0].GetString(), id);
      const std::string payload =
          *listing->files[0].GetDict().FindString("payload");
      EXPECT_EQ(payload.find("correct horse"), std::string::npos);
      std::optional<Secret> restored = RestorePasswords(payload, keys);
      ASSERT_TRUE(restored);
      EXPECT_EQ(Json(restored->view()),
                Json(*file.GetDict().FindString("payload")));
      auto again = vault->Read(scope, {id}, base::Time::Now());
      ASSERT_TRUE(again.has_value());
      EXPECT_TRUE(again->files.empty());
      EXPECT_EQ(again->present.size(), 1u);
    }
    const base::DictValue* local = m.FindDict("local");
    std::optional<Secret> sealed = FromBase64(*local->FindString("sealed"));
    std::optional<Secret> plain = keys.Open(sealed->view(), "local", "state");
    ASSERT_TRUE(plain);
    EXPECT_EQ(plain->str(), *local->FindString("plain"));
    const base::DictValue* password = m.FindDict("password");
    std::optional<Secret> opened = keys.OpenPassword(
        *password->FindString("sealed"), *password->FindString("origin"),
        *password->FindString("username"));
    ASSERT_TRUE(opened);
    EXPECT_EQ(opened->str(), *password->FindString("password"));
  }
}

TEST_F(SyncFixturesTest, PasswordsSealByteForByteLikeTheMacAndWindows) {
  for (const char* side : kSides) {
    base::DictValue m = Manifest(side);
    Keys keys = KeysOf(Bytes(*m.FindString("entropy")));
    const base::DictValue* password = m.FindDict("password");
    EXPECT_EQ(keys.SealPassword(*password->FindString("password"),
                                *password->FindString("origin"),
                                *password->FindString("username")),
              *password->FindString("sealed"));
  }
}

TEST_F(SyncFixturesTest, WhatLinuxWritesOpensAgainAndLeavesNoTrace) {
  base::DictValue m = Manifest("windows");
  Keys keys = KeysOf(Bytes(*m.FindString("entropy")));
  base::ScopedTempDir folder;
  ASSERT_TRUE(folder.CreateUniqueTempDir());
  auto vault = Vault::At(folder.GetPath().value(), keys);
  ASSERT_TRUE(vault.has_value());
  EXPECT_EQ(vault->ChainStatus(), "missing");
  ASSERT_TRUE(vault->CreateChain().has_value());
  EXPECT_EQ(vault->ChainStatus(), "ok");
  for (const base::Value& file : *m.FindList("files")) {
    const std::string scope = *file.GetDict().FindString("scope");
    const std::string payload = *file.GetDict().FindString("payload");
    std::optional<std::string> hidden = HidePasswords(payload, keys);
    ASSERT_TRUE(hidden);
    auto id = vault->Write(scope, *hidden);
    ASSERT_TRUE(id.has_value());
    std::string written;
    ASSERT_TRUE(base::ReadFileToString(
        vault->ScopePath(scope).Append(*id + ".nns"), &written));
    EXPECT_EQ(written.size() % 1024, 4u + 12u + 16u);
    std::optional<Secret> plain =
        keys.Open(written, keys.ScopeTag(scope), *id);
    ASSERT_TRUE(plain);
    EXPECT_EQ(Json(plain->view()), Json(payload));
  }
  std::optional<std::string> password =
      keys.SealPassword("pässwörd ✓", "https://ardia.dev", "nathan");
  EXPECT_EQ(keys.OpenPassword(*password, "https://ardia.dev", "nathan")->str(),
            "pässwörd ✓");
  EXPECT_FALSE(keys.OpenPassword(*password, "https://ardia.dev", "other"));
  const std::string scope = *(*m.FindList("files"))[0].GetDict().FindString(
      "scope");
  auto listing = vault->Read(scope, {}, base::Time::Now());
  ASSERT_EQ(listing->present.size(), 1u);
  ASSERT_TRUE(
      vault->Remove(scope, {listing->present[0].GetString()}).has_value());
  EXPECT_TRUE(vault->Read(scope, {}, base::Time::Now())->present.empty());
  ASSERT_TRUE(vault->DeleteChain().has_value());
  EXPECT_TRUE(base::IsDirectoryEmpty(folder.GetPath()));
}

TEST(SyncVaultTest, DamagedAndForeignFilesAreReportedNotThrown) {
  Keys keys = KeysOf(std::string(32, '\x01'));
  Keys other = KeysOf(std::string(32, '\x09'));
  base::ScopedTempDir folder;
  ASSERT_TRUE(folder.CreateUniqueTempDir());
  auto vault = Vault::At(folder.GetPath().value(), keys);
  ASSERT_TRUE(vault->CreateChain().has_value());
  auto good = vault->Write("app", "{\"a\":1}");
  ASSERT_TRUE(good.has_value());
  const std::string bad = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
  ASSERT_TRUE(base::WriteFile(
      vault->ScopePath("app").Append(bad + ".nns"),
      *other.Seal("{}", keys.ScopeTag("app"), bad)));
  ASSERT_TRUE(base::WriteFile(vault->ScopePath("app").Append("notes.txt"),
                              "hello"));
  auto listing =
      vault->Read("app", {}, base::Time::Now() + base::Seconds(60));
  ASSERT_TRUE(listing.has_value());
  ASSERT_EQ(listing->files.size(), 1u);
  EXPECT_EQ(*listing->files[0].GetDict().FindString("id"), *good);
  EXPECT_EQ(*listing->files[0].GetDict().FindString("payload"), "{\"a\":1}");
  ASSERT_EQ(listing->damaged.size(), 1u);
  EXPECT_EQ(*listing->damaged[0].GetDict().FindString("id"), bad);
  EXPECT_GE(listing->damaged[0].GetDict().FindDouble("age").value_or(0),
            59000);
}

TEST(SyncVaultTest, RemovingRefusesAScopeFolderThatIsALink) {
  Keys keys = KeysOf(std::string(32, '\x07'));
  base::ScopedTempDir root;
  ASSERT_TRUE(root.CreateUniqueTempDir());
  base::FilePath folder = root.GetPath().Append("vault");
  base::FilePath victim = root.GetPath().Append("victim");
  ASSERT_TRUE(base::CreateDirectory(victim));
  const std::string id = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
  ASSERT_TRUE(base::WriteFile(victim.Append(id + ".nns"), "keep me"));
  auto vault = Vault::At(folder.value(), keys);
  EXPECT_TRUE(vault->Remove("app", {id}).has_value());
  ASSERT_TRUE(vault->CreateChain().has_value());
  ASSERT_TRUE(base::CreateSymbolicLink(victim, vault->ScopePath("app")));
  auto refused = vault->Remove("app", {id});
  ASSERT_FALSE(refused.has_value());
  EXPECT_NE(refused.error().message.find("link where sync data belongs"),
            std::string::npos);
  std::string kept;
  ASSERT_TRUE(base::ReadFileToString(victim.Append(id + ".nns"), &kept));
  EXPECT_EQ(kept, "keep me");
  EXPECT_TRUE(vault->Remove("bookmarks", {id}).has_value());
  EXPECT_FALSE(Vault::At("relative/folder", keys).has_value());
}

TEST(SyncLoginsTest, PasswordsAreSealedOnTheWayOutAndOpenedOnTheWayIn) {
  Keys keys = KeysOf(std::string(32, '\x03'));
  const std::string payload =
      R"({"records":{"pw:1":{"k":"pw:1","v":{"o":"https://a.com","u":"ada","p":"secret"}},"pw:2":"stray","pw:3":{"v":{"p":"no origin"}}},"x":1})";
  std::optional<std::string> hidden = HidePasswords(payload, keys);
  ASSERT_TRUE(hidden);
  EXPECT_EQ(hidden->find("secret"), std::string::npos);
  EXPECT_EQ(hidden->find("no origin"), std::string::npos);
  EXPECT_EQ(hidden->find("stray"), std::string::npos);
  std::optional<Secret> restored = RestorePasswords(*hidden, keys);
  ASSERT_TRUE(restored);
  base::Value back = Json(restored->view());
  EXPECT_EQ(*back.GetDict().FindStringByDottedPath("records.pw:1.v.p"),
            "secret");
  EXPECT_EQ(HidePasswords("{\"plain\":true}", keys), "{\"plain\":true}");
  EXPECT_FALSE(RestorePasswords(
      R"({"pw:1":{"v":{"o":"https://a.com","u":"ada","s":"AAAA"}}})", keys));
}

TEST(SyncLoginsTest, EngineLoginsAreSealedPerOriginOnce) {
  Keys keys = KeysOf(std::string(32, '\x05'));
  std::optional<base::ListValue> sealed = SealedLogins(
      R"({"logins":[{"realm":"https://a.com/","username":"ada","password":"one","created":5},{"realm":"https://a.com/","username":"ada","password":"two","created":6},{"realm":"android://x","username":"z","password":"p","created":1}]})",
      keys);
  ASSERT_TRUE(sealed);
  ASSERT_EQ(sealed->size(), 1u);
  const base::DictValue& login = (*sealed)[0].GetDict();
  EXPECT_EQ(*login.FindString("origin"), "https://a.com");
  EXPECT_EQ(keys.OpenPassword(*login.FindString("sealed"), "https://a.com",
                              "ada")
                ->str(),
            "one");
  EXPECT_FALSE(SealedLogins(R"({"logins":[{"realm":"https://a.com"}]})", keys));
  EXPECT_EQ(LoginOrigin("https://a.com/"), "https://a.com");
  EXPECT_FALSE(LoginOrigin("https://a.com/path"));
  EXPECT_FALSE(LoginOrigin("ftp://a.com"));
}

TEST(SyncCryptoTest, TagsAndFileIds) {
  EXPECT_TRUE(IsTag(NewFileId()));
  EXPECT_FALSE(IsTag("ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
  EXPECT_FALSE(IsTag("abc"));
}

}

}
