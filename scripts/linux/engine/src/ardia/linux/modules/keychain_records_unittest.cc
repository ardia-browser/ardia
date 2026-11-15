// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/keychain_records.h"

#include "testing/gtest/include/gtest/gtest.h"

namespace ardia_linux {

namespace {

TEST(KeychainRecordsTest, TheCiphertextTagNamesTheBackend) {
  EXPECT_EQ(SealKindOf("v10abc"), SealKind::kBasic);
  EXPECT_EQ(SealKindOf("v11abc"), SealKind::kKeyring);
  EXPECT_EQ(SealKindOf("v12abc"), SealKind::kPortal);
  EXPECT_EQ(SealKindOf("xx"), SealKind::kUnknown);
  EXPECT_EQ(SealKindName(SealKind::kBasic), "basic_text");
  EXPECT_TRUE(IsKeyring(SealKind::kPortal));
  EXPECT_FALSE(IsKeyring(SealKind::kBasic));
}

TEST(KeychainRecordsTest, ABasicSecretMovesToAKeyringOnceOneIsThere) {
  EXPECT_TRUE(NeedsResealing(SealKind::kBasic, SealKind::kKeyring));
  EXPECT_TRUE(NeedsResealing(SealKind::kBasic, SealKind::kPortal));
  EXPECT_FALSE(NeedsResealing(SealKind::kBasic, SealKind::kBasic));
  EXPECT_FALSE(NeedsResealing(SealKind::kKeyring, SealKind::kBasic));
  EXPECT_FALSE(NeedsResealing(SealKind::kKeyring, SealKind::kPortal));
}

TEST(KeychainRecordsTest, RecordsRoundTripAndRejectPlainOnes) {
  KeychainRecord record{"secret_service", std::string("v11\x00\xff", 5)};
  std::optional<KeychainRecord> back = RecordFromJson(RecordJson(record));
  ASSERT_TRUE(back);
  EXPECT_EQ(back->ciphertext, record.ciphertext);
  EXPECT_EQ(back->backend, "secret_service");
  EXPECT_FALSE(RecordFromJson(R"({"backend":"x","sealed":false,"value":"aGk="})"));
  EXPECT_FALSE(RecordFromJson("not json"));
}

TEST(KeychainRecordsTest, ItemFilesAreNamedByAHashOfTheAccount) {
  EXPECT_EQ(ItemFileName("sync"), ItemFileName("sync"));
  EXPECT_NE(ItemFileName("sync"), ItemFileName("../sync"));
  EXPECT_EQ(ItemFileName("../../etc/passwd").find('/'), std::string::npos);
  EXPECT_EQ(ItemFileName("a").size(), 64u + 5u);
}

}

}
