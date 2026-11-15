// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/translate/translate_models.h"

#include <string>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/json/json_reader.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/zlib/google/compression_utils.h"

namespace ardia_linux::translate {

namespace {

constexpr char kHashA[] =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

base::Value Registry() {
  return *base::JSONReader::Read(R"({
    "fr-en": [
      {"releaseStatus": "Nightly", "architecture": "base", "files": {}},
      {"releaseStatus": "Release", "architecture": "tiny", "files": {
        "model": {"path": "models/fr-en/v2/model.bin.gz", "uncompressedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "uncompressedSize": 10},
        "lexicalShortlist": {"path": "models/fr-en/v2/lex.bin.gz"},
        "vocab": {"path": "models/fr-en/v2/vocab.spm.gz"}}},
      {"releaseStatus": "Release", "architecture": "base", "files": {
        "model": {"path": "models/fr-en/v1/model.bin.gz", "uncompressedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "lexicalShortlist": {"path": "models/fr-en/v1/lex.bin.gz"},
        "vocab": {"path": "models/fr-en/v1/vocab.spm.gz"}}}
    ],
    "en-zh": [{"releaseStatus": "Release", "architecture": "base", "files": {
        "model": {"path": "models/en-zh/v1/model.gz", "uncompressedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "lexicalShortlist": {"path": "models/en-zh/v1/lex.gz"},
        "srcVocab": {"path": "models/en-zh/v1/src.gz"},
        "trgVocab": {"path": "models/en-zh/v1/trg.gz"}}}],
    "de-fr": [{"releaseStatus": "Release", "files": {}}],
    "en-xx": [{"releaseStatus": "Release", "files": {
        "model": {"path": "../escape.gz", "uncompressedHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
        "lexicalShortlist": {"path": "models/x/lex.gz"},
        "vocab": {"path": "models/x/vocab.gz"}}}]
  })",
                                 base::JSON_PARSE_RFC);
}

TEST(TranslateModelsTest, TheRegistryGivesTheBestReleasedCompletePairs) {
  Pairs pairs = CatalogFromRegistry(Registry());
  ASSERT_TRUE(pairs.contains("fr>en"));
  EXPECT_EQ(pairs["fr>en"].version, "v1");
  EXPECT_EQ(pairs["fr>en"].files["model"].hash, kHashA);
  ASSERT_TRUE(pairs.contains("en>zh-Hans"));
  EXPECT_TRUE(pairs["en>zh-Hans"].files.contains("srcvocab"));
  EXPECT_FALSE(pairs.contains("de>fr"));
  EXPECT_FALSE(pairs.contains("en>xx"));
}

TEST(TranslateModelsTest, RoutesPivotThroughEnglish) {
  Catalog catalog;
  catalog.pairs = CatalogFromRegistry(Registry());
  std::optional<Catalog> known(std::move(catalog));
  EXPECT_EQ(*Route("fr", "en", known), std::vector<std::string>({"fr>en"}));
  EXPECT_EQ(*Route("fr", "zh-Hans", known),
            std::vector<std::string>({"fr>en", "en>zh-Hans"}));
  EXPECT_FALSE(Route("en", "fr", known));
  EXPECT_FALSE(Route("fr", "fr", known));
  EXPECT_EQ(*Route("de", "fr", std::nullopt),
            std::vector<std::string>({"de>en", "en>fr"}));
  std::string json = CatalogToJson(*known);
  std::optional<Catalog> back = CatalogFromJson(json);
  ASSERT_TRUE(back);
  EXPECT_EQ(back->pairs.size(), known->pairs.size());
}

TEST(TranslateModelsTest, GunzipChecksSizeAndHashesWhatItWrote) {
  base::ScopedTempDir scratch;
  ASSERT_TRUE(scratch.CreateUniqueTempDir());
  std::string gzipped;
  ASSERT_TRUE(compression::GzipCompress(std::string("hello model"), &gzipped));
  base::FilePath gz = scratch.GetPath().Append("model.gz");
  ASSERT_TRUE(base::WriteFile(gz, gzipped));
  std::optional<Digest> digest =
      GunzipInto(gz, scratch.GetPath().Append("model"), 0);
  ASSERT_TRUE(digest);
  EXPECT_EQ(digest->size, 11);
  EXPECT_EQ(digest->hash, DigestOf(scratch.GetPath().Append("model"))->hash);
  EXPECT_EQ(digest->hash.size(), 64u);
  EXPECT_FALSE(GunzipInto(gz, scratch.GetPath().Append("small"), 5));
  EXPECT_FALSE(base::PathExists(scratch.GetPath().Append("small")));
  ASSERT_TRUE(base::WriteFile(gz, "not gzip"));
  EXPECT_FALSE(GunzipInto(gz, scratch.GetPath().Append("bad"), 0));
}

TEST(TranslateModelsTest, AManifestCountsOnlyWhenItsFilesAreThere) {
  base::ScopedTempDir scratch;
  ASSERT_TRUE(scratch.CreateUniqueTempDir());
  Manifest manifest;
  manifest.version = "v1";
  for (const char* type : {"model", "lex", "vocab"}) {
    ASSERT_TRUE(base::WriteFile(scratch.GetPath().Append(type), "1234"));
    manifest.files[type] = {4, kHashA};
  }
  ASSERT_TRUE(WriteManifest(scratch.GetPath(), manifest));
  std::optional<Manifest> read = ReadManifest(scratch.GetPath());
  ASSERT_TRUE(read);
  EXPECT_EQ(read->files["model"].hash, kHashA);
  ASSERT_TRUE(base::WriteFile(scratch.GetPath().Append("lex"), "12345"));
  EXPECT_FALSE(ReadManifest(scratch.GetPath()));
}

}

}
