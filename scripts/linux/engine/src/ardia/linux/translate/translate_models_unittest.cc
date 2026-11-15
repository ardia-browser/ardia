// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/translate/translate_models.h"

#include <string>
#include <vector>

#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/json/json_reader.h"
#include "testing/gtest/include/gtest/gtest.h"
#include "third_party/zlib/google/compression_utils.h"
#include "third_party/zlib/zlib.h"

namespace ardia_linux::translate {

namespace {

constexpr char kHashA[] =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

constexpr int64_t kBombBytes = int64_t{300} << 20;

bool WriteZerosGzipped(const base::FilePath& path, int64_t expanded) {
  z_stream stream = {};
  if (deflateInit2(&stream, Z_BEST_COMPRESSION, Z_DEFLATED, 16 + MAX_WBITS, 9,
                   Z_DEFAULT_STRATEGY) != Z_OK) {
    return false;
  }
  std::vector<uint8_t> zeros(1 << 20, 0);
  std::vector<uint8_t> out(1 << 16);
  std::string gzipped;
  int64_t left = expanded;
  int status = Z_OK;
  while (status != Z_STREAM_END) {
    const size_t take =
        static_cast<size_t>(std::min<int64_t>(left, zeros.size()));
    left -= static_cast<int64_t>(take);
    stream.next_in = zeros.data();
    stream.avail_in = static_cast<uInt>(take);
    const int flush = left == 0 ? Z_FINISH : Z_NO_FLUSH;
    do {
      stream.next_out = out.data();
      stream.avail_out = static_cast<uInt>(out.size());
      status = deflate(&stream, flush);
      gzipped.append(reinterpret_cast<const char*>(out.data()),
                     out.size() - stream.avail_out);
    } while (stream.avail_out == 0);
    if (flush == Z_NO_FLUSH && status != Z_OK) {
      break;
    }
  }
  deflateEnd(&stream);
  return status == Z_STREAM_END && base::WriteFile(path, gzipped);
}

base::DictValue RegistryFile(std::string_view path) {
  base::DictValue file;
  file.Set("path", path);
  file.Set("uncompressedHash", kHashA);
  return file;
}

base::Value RegistryWithModelSize(std::optional<double> size) {
  base::DictValue model = RegistryFile("models/fr-en/v1/model.bin.gz");
  if (size) {
    model.Set("uncompressedSize", *size);
  }
  base::DictValue files;
  files.Set("model", std::move(model));
  files.Set("lexicalShortlist", RegistryFile("models/fr-en/v1/lex.bin.gz"));
  files.Set("vocab", RegistryFile("models/fr-en/v1/vocab.spm.gz"));
  base::DictValue entry;
  entry.Set("releaseStatus", "Release");
  entry.Set("architecture", "base");
  entry.Set("files", std::move(files));
  base::ListValue entries;
  entries.Append(std::move(entry));
  base::DictValue models;
  models.Set("fr-en", std::move(entries));
  return base::Value(std::move(models));
}

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

TEST(TranslateModelsTest, AGzipBombStopsAtTheCapWithoutADeclaredSize) {
  base::ScopedTempDir scratch;
  ASSERT_TRUE(scratch.CreateUniqueTempDir());
  const base::FilePath bomb = scratch.GetPath().Append("bomb.gz");
  ASSERT_TRUE(WriteZerosGzipped(bomb, kBombBytes));
  std::optional<int64_t> gzipped_size = base::GetFileSize(bomb);
  ASSERT_TRUE(gzipped_size);
  EXPECT_LT(*gzipped_size, int64_t{1} << 20);
  const base::FilePath target = scratch.GetPath().Append("model");
  EXPECT_FALSE(GunzipInto(bomb, target, 0));
  EXPECT_FALSE(base::PathExists(target));
  EXPECT_FALSE(GunzipInto(bomb, target, kBombBytes));
  EXPECT_FALSE(base::PathExists(target));
  EXPECT_FALSE(GunzipInto(bomb, target, -1));
  EXPECT_FALSE(base::PathExists(target));
  EXPECT_EQ(ExpansionLimit(0), kMaxExpandedFileBytes);
  EXPECT_EQ(ExpansionLimit(-1), kMaxExpandedFileBytes);
  EXPECT_EQ(ExpansionLimit(kBombBytes), kMaxExpandedFileBytes);
  EXPECT_EQ(ExpansionLimit(59504955), 59504955);
  EXPECT_LT(kMaxExpandedFileBytes, kBombBytes);
}

TEST(TranslateModelsTest, AMissingSizeIsCappedAndABadOneDropsThePair) {
  Pairs missing = CatalogFromRegistry(RegistryWithModelSize(std::nullopt));
  ASSERT_TRUE(missing.contains("fr>en"));
  EXPECT_EQ(missing["fr>en"].files["model"].size, 0);
  Pairs declared = CatalogFromRegistry(RegistryWithModelSize(59504955));
  ASSERT_TRUE(declared.contains("fr>en"));
  EXPECT_EQ(declared["fr>en"].files["model"].size, 59504955);
  for (double bad : {1e30, -5.0, 0.0, 1e19, double{int64_t{1} << 40},
                     double(kMaxExpandedFileBytes + 1)}) {
    EXPECT_FALSE(CatalogFromRegistry(RegistryWithModelSize(bad))
                     .contains("fr>en"))
        << bad;
  }
}

TEST(TranslateModelsTest, ACachedCatalogWithAnOutOfRangeSizeDropsThePair) {
  std::optional<Catalog> catalog = CatalogFromJson(std::string(R"({"source": ")") +
                                                    kRegistry + R"(", "fetchedAt": 1,
    "pairs": {"fr>en": {"version": "v1", "files": {
      "model": {"path": "models/fr-en/v1/model.bin.gz", "size": 1e30},
      "lex": {"path": "models/fr-en/v1/lex.bin.gz"},
      "vocab": {"path": "models/fr-en/v1/vocab.spm.gz"}}}}})");
  ASSERT_TRUE(catalog);
  EXPECT_FALSE(catalog->pairs.contains("fr>en"));
}

TEST(TranslateModelsTest, DetectsWithChromesLanguageIdentifier) {
  EXPECT_EQ(DetectedLanguage("Ceci est une phrase en français pour la "
                             "détection de la langue, avec plusieurs mots."),
            "fr");
  EXPECT_EQ(DetectedLanguage("Dies ist ein deutscher Satz, der lang genug "
                             "ist, um erkannt zu werden."),
            "de");
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
