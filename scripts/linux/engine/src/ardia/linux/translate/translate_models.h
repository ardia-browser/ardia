// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_TRANSLATE_TRANSLATE_MODELS_H_
#define ARDIA_LINUX_TRANSLATE_TRANSLATE_MODELS_H_

#include <array>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"

namespace ardia_linux::translate {

inline constexpr char kStore[] =
    "https://storage.googleapis.com/"
    "moz-fx-translations-data--303e-prod-translations-data/";
inline constexpr char kRegistry[] =
    "https://storage.googleapis.com/"
    "moz-fx-translations-data--303e-prod-translations-data/db/models.json";
inline constexpr char kPivot[] = "en";
inline constexpr std::array<const char*, 5> kFileTypes = {
    "model", "lex", "vocab", "srcvocab", "trgvocab"};

struct RemoteFile {
  std::string path;
  std::string hash;
  int64_t size = 0;
};

struct PairFiles {
  std::string version;
  std::map<std::string, RemoteFile> files;
};

using Pairs = std::map<std::string, PairFiles>;

struct Catalog {
  double fetched_at = 0;
  Pairs pairs;
};

struct ManifestFile {
  int64_t size = 0;
  std::string hash;
};

struct Manifest {
  std::string version;
  std::map<std::string, ManifestFile> files;
};

std::string PairKey(std::string_view from, std::string_view to);
std::string PairFolderName(std::string_view pair);

Pairs CatalogFromRegistry(const base::Value& models);
std::optional<Catalog> CatalogFromJson(std::string_view json);
std::string CatalogToJson(const Catalog& catalog);

std::set<std::string> KnownPairs(const std::optional<Catalog>& catalog);
std::optional<std::vector<std::string>> Route(
    std::string_view from,
    std::string_view to,
    const std::optional<Catalog>& catalog);
std::vector<std::string> Languages(const std::optional<Catalog>& catalog);

bool CompleteFiles(const std::set<std::string>& types);

std::optional<Manifest> ReadManifest(const base::FilePath& pair_folder);
bool WriteManifest(const base::FilePath& pair_folder, const Manifest& manifest);

struct Digest {
  int64_t size = 0;
  std::string hash;
};

std::optional<Digest> DigestOf(const base::FilePath& path);

std::optional<Digest> GunzipInto(const base::FilePath& gzipped,
                                 const base::FilePath& target,
                                 int64_t size_limit);

}

#endif
