// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/translate/translate_models.h"

#include <algorithm>
#include <utility>

#include "base/files/file.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/boringssl/src/include/openssl/sha.h"
#include "third_party/cld_3/src/src/nnet_language_identifier.h"
#include "third_party/re2/src/re2/re2.h"
#include "third_party/zlib/zlib.h"

namespace ardia_linux::translate {

namespace {

constexpr std::array<const char*, 2> kReleased = {"Release",
                                                  "Release Desktop"};
constexpr std::array<const char*, 3> kArchitectures = {"base", "base-memory",
                                                       "tiny"};
constexpr char kKnownFromEnglish[] =
    "af ar az be bg bn bs ca cs da de el es et eu fa fi fr gl gu he hi hr hu "
    "id is it ja kn ko lt lv ml mr ms nb nl pl pt ro ru sk sl sq sr sv ta te "
    "th tl tr ug uk ur vi zh-Hans zh-Hant";
constexpr char kKnownToEnglish[] =
    "af ar be bg bn ca cs da de el es et eu fa fi fr gl gu he hi hu id is it "
    "ja kn ko lt lv ml mr ms nb nl pl pt ro ru sk sl sq sv ta te th tl tr ug "
    "uk ur vi zh-Hans zh-Hant";
constexpr size_t kChunk = 1 << 16;

std::string RegistryLanguage(std::string_view raw) {
  if (raw == "zh") {
    return "zh-Hans";
  }
  if (raw == "zh_hant") {
    return "zh-Hant";
  }
  if (raw == "no") {
    return "nb";
  }
  return std::string(raw);
}

bool Renamed(std::string_view raw) {
  return raw == "zh" || raw == "zh_hant" || raw == "no";
}

bool IsLanguage(const std::string& code) {
  static const re2::LazyRE2 kLanguage = {"[a-z]{2,3}(?:-[A-Z][a-z]{3})?"};
  return re2::RE2::FullMatch(code, *kLanguage);
}

std::string FileTypeOf(std::string_view registry_name) {
  if (registry_name == "model") {
    return "model";
  }
  if (registry_name == "lexicalShortlist") {
    return "lex";
  }
  if (registry_name == "vocab") {
    return "vocab";
  }
  if (registry_name == "srcVocab") {
    return "srcvocab";
  }
  if (registry_name == "trgVocab") {
    return "trgvocab";
  }
  return std::string();
}

int IndexIn(const auto& list, const std::string& value) {
  for (size_t i = 0; i < list.size(); ++i) {
    if (value == list[i]) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

int Rank(const base::DictValue& entry) {
  const std::string* status = entry.FindString("releaseStatus");
  const std::string* architecture = entry.FindString("architecture");
  return IndexIn(kReleased, status ? *status : std::string()) *
             static_cast<int>(kArchitectures.size()) +
         std::max(0, IndexIn(kArchitectures,
                             architecture ? *architecture : std::string()));
}

std::set<std::string> TypesOf(const std::map<std::string, RemoteFile>& files) {
  std::set<std::string> types;
  for (const auto& [type, file] : files) {
    types.insert(type);
  }
  return types;
}

std::optional<PairFiles> FilesOf(const base::DictValue& entry) {
  const base::DictValue* listed = entry.FindDict("files");
  if (!listed) {
    return std::nullopt;
  }
  static const re2::LazyRE2 kStorePath = {"models/[A-Za-z0-9_\\-./]+\\.gz"};
  static const re2::LazyRE2 kHash = {"[0-9a-f]{64}"};
  PairFiles pair;
  for (const auto [name, value] : *listed) {
    const std::string type = FileTypeOf(name);
    const base::DictValue* file = value.GetIfDict();
    const std::string* path = file ? file->FindString("path") : nullptr;
    if (type.empty() || !path || !re2::RE2::FullMatch(*path, *kStorePath) ||
        path->find("..") != std::string::npos) {
      continue;
    }
    RemoteFile remote;
    remote.path = *path;
    if (const std::string* hash = file->FindString("uncompressedHash");
        hash && re2::RE2::FullMatch(*hash, *kHash)) {
      remote.hash = *hash;
    }
    if (std::optional<double> size = file->FindDouble("uncompressedSize");
        size && *size > 0) {
      remote.size = static_cast<int64_t>(*size);
    }
    pair.files[type] = std::move(remote);
  }
  auto model = pair.files.find("model");
  if (!CompleteFiles(TypesOf(pair.files)) || model == pair.files.end() ||
      model->second.hash.empty()) {
    return std::nullopt;
  }
  std::vector<std::string> parts = base::SplitString(
      model->second.path, "/", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
  pair.version = parts.size() > 2 ? parts[2] : model->second.hash;
  return pair;
}

}

std::string PairKey(std::string_view from, std::string_view to) {
  return std::string(from) + ">" + std::string(to);
}

std::string PairFolderName(std::string_view pair) {
  std::string folder(pair);
  std::replace(folder.begin(), folder.end(), '>', '-');
  return folder;
}

bool CompleteFiles(const std::set<std::string>& types) {
  return types.contains("model") && types.contains("lex") &&
         (types.contains("vocab") ||
          (types.contains("srcvocab") && types.contains("trgvocab")));
}

Pairs CatalogFromRegistry(const base::Value& models) {
  Pairs pairs;
  const base::DictValue* dict = models.GetIfDict();
  if (!dict) {
    return pairs;
  }
  for (const auto [key, entries] : *dict) {
    std::vector<std::string> parts =
        base::SplitString(key, "-", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL);
    if (parts.size() != 2 || parts[0].empty() || parts[1].empty() ||
        !entries.is_list()) {
      continue;
    }
    const std::string from = RegistryLanguage(parts[0]);
    const std::string to = RegistryLanguage(parts[1]);
    if (!IsLanguage(from) || !IsLanguage(to) ||
        (from != kPivot && to != kPivot)) {
      continue;
    }
    std::vector<const base::DictValue*> released;
    for (const base::Value& entry : entries.GetList()) {
      const base::DictValue* candidate = entry.GetIfDict();
      const std::string* status =
          candidate ? candidate->FindString("releaseStatus") : nullptr;
      if (status && IndexIn(kReleased, *status) >= 0) {
        released.push_back(candidate);
      }
    }
    std::stable_sort(released.begin(), released.end(),
                     [](const base::DictValue* a, const base::DictValue* b) {
                       return Rank(*a) < Rank(*b);
                     });
    const std::string pair = PairKey(from, to);
    if (pairs.contains(pair) &&
        Renamed(parts[0] == kPivot ? parts[1] : parts[0])) {
      continue;
    }
    for (const base::DictValue* entry : released) {
      if (std::optional<PairFiles> files = FilesOf(*entry)) {
        pairs[pair] = std::move(*files);
        break;
      }
    }
  }
  return pairs;
}

std::optional<Catalog> CatalogFromJson(std::string_view json) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  const base::DictValue* dict = parsed ? parsed->GetIfDict() : nullptr;
  const std::string* source = dict ? dict->FindString("source") : nullptr;
  std::optional<double> fetched =
      dict ? dict->FindDouble("fetchedAt") : std::nullopt;
  const base::DictValue* pairs = dict ? dict->FindDict("pairs") : nullptr;
  if (!source || *source != kRegistry || !fetched || !pairs) {
    return std::nullopt;
  }
  Catalog catalog;
  catalog.fetched_at = *fetched;
  for (const auto [key, value] : *pairs) {
    const base::DictValue* entry = value.GetIfDict();
    const std::string* version = entry ? entry->FindString("version") : nullptr;
    const base::DictValue* files = entry ? entry->FindDict("files") : nullptr;
    if (!version || !files) {
      continue;
    }
    PairFiles pair;
    pair.version = *version;
    for (const auto [type, file] : *files) {
      const base::DictValue* fields = file.GetIfDict();
      const std::string* path = fields ? fields->FindString("path") : nullptr;
      if (!path) {
        continue;
      }
      RemoteFile remote;
      remote.path = *path;
      if (const std::string* hash = fields->FindString("hash")) {
        remote.hash = *hash;
      }
      remote.size =
          static_cast<int64_t>(fields->FindDouble("size").value_or(0));
      pair.files[type] = std::move(remote);
    }
    if (CompleteFiles(TypesOf(pair.files))) {
      catalog.pairs[key] = std::move(pair);
    }
  }
  return catalog;
}

std::string CatalogToJson(const Catalog& catalog) {
  base::DictValue pairs;
  for (const auto& [key, pair] : catalog.pairs) {
    base::DictValue files;
    for (const auto& [type, file] : pair.files) {
      base::DictValue fields;
      fields.Set("path", file.path);
      if (!file.hash.empty()) {
        fields.Set("hash", file.hash);
      }
      if (file.size) {
        fields.Set("size", static_cast<double>(file.size));
      }
      files.Set(type, std::move(fields));
    }
    pairs.Set(key, base::DictValue()
                       .Set("version", pair.version)
                       .Set("files", std::move(files)));
  }
  return base::WriteJson(base::DictValue()
                             .Set("source", kRegistry)
                             .Set("fetchedAt", catalog.fetched_at)
                             .Set("pairs", std::move(pairs)))
      .value_or("{}");
}

std::set<std::string> KnownPairs(const std::optional<Catalog>& catalog) {
  std::set<std::string> known;
  if (catalog) {
    for (const auto& [key, pair] : catalog->pairs) {
      known.insert(key);
    }
    return known;
  }
  for (const std::string& language :
       base::SplitString(kKnownFromEnglish, " ", base::TRIM_WHITESPACE,
                         base::SPLIT_WANT_NONEMPTY)) {
    known.insert(PairKey(kPivot, language));
  }
  for (const std::string& language :
       base::SplitString(kKnownToEnglish, " ", base::TRIM_WHITESPACE,
                         base::SPLIT_WANT_NONEMPTY)) {
    known.insert(PairKey(language, kPivot));
  }
  return known;
}

std::optional<std::vector<std::string>> Route(
    std::string_view from,
    std::string_view to,
    const std::optional<Catalog>& catalog) {
  if (from == to) {
    return std::nullopt;
  }
  const std::set<std::string> known = KnownPairs(catalog);
  if (from == kPivot || to == kPivot) {
    const std::string pair = PairKey(from, to);
    return known.contains(pair)
               ? std::optional<std::vector<std::string>>({pair})
               : std::nullopt;
  }
  const std::string first = PairKey(from, kPivot);
  const std::string second = PairKey(kPivot, to);
  return known.contains(first) && known.contains(second)
             ? std::optional<std::vector<std::string>>({first, second})
             : std::nullopt;
}

std::vector<std::string> Languages(const std::optional<Catalog>& catalog) {
  std::vector<std::string> out = {kPivot};
  for (const std::string& pair : KnownPairs(catalog)) {
    const size_t split = pair.find('>');
    const std::string from = pair.substr(0, split);
    const std::string to = pair.substr(split + 1);
    const std::string other = from == kPivot ? to : from;
    if (std::find(out.begin(), out.end(), other) == out.end()) {
      out.push_back(other);
    }
  }
  return out;
}

std::optional<Manifest> ReadManifest(const base::FilePath& pair_folder) {
  std::string json;
  if (!base::ReadFileToStringWithMaxSize(pair_folder.Append("manifest.json"),
                                         &json, 1 << 20)) {
    return std::nullopt;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  const base::DictValue* dict = parsed ? parsed->GetIfDict() : nullptr;
  const std::string* version = dict ? dict->FindString("version") : nullptr;
  const base::DictValue* files = dict ? dict->FindDict("files") : nullptr;
  if (!version || !files) {
    return std::nullopt;
  }
  Manifest manifest;
  manifest.version = *version;
  std::set<std::string> types;
  for (const auto [type, value] : *files) {
    const base::DictValue* fields = value.GetIfDict();
    if (IndexIn(kFileTypes, type) < 0 || !fields) {
      return std::nullopt;
    }
    ManifestFile file;
    file.size = static_cast<int64_t>(fields->FindDouble("size").value_or(-1));
    if (const std::string* hash = fields->FindString("hash")) {
      file.hash = *hash;
    }
    std::optional<int64_t> on_disk = base::GetFileSize(pair_folder.Append(type));
    if (!on_disk || *on_disk != file.size) {
      return std::nullopt;
    }
    manifest.files[type] = std::move(file);
    types.insert(type);
  }
  if (!CompleteFiles(types)) {
    return std::nullopt;
  }
  return manifest;
}

bool WriteManifest(const base::FilePath& pair_folder,
                   const Manifest& manifest) {
  base::DictValue files;
  for (const auto& [type, file] : manifest.files) {
    files.Set(type, base::DictValue()
                        .Set("size", static_cast<double>(file.size))
                        .Set("hash", file.hash));
  }
  const std::string json =
      base::WriteJson(base::DictValue()
                          .Set("version", manifest.version)
                          .Set("files", std::move(files)))
          .value_or("{}");
  const base::FilePath staging = pair_folder.Append("manifest.json.tmp");
  return base::WriteFile(staging, json) &&
         base::Move(staging, pair_folder.Append("manifest.json"));
}

std::optional<Digest> DigestOf(const base::FilePath& path) {
  base::File file(path, base::File::FLAG_OPEN | base::File::FLAG_READ);
  if (!file.IsValid()) {
    return std::nullopt;
  }
  SHA256_CTX context;
  SHA256_Init(&context);
  Digest digest;
  std::vector<uint8_t> buffer(kChunk);
  while (true) {
    std::optional<size_t> got = file.ReadAtCurrentPos(buffer);
    if (!got) {
      return std::nullopt;
    }
    if (*got == 0) {
      break;
    }
    SHA256_Update(&context, buffer.data(), *got);
    digest.size += static_cast<int64_t>(*got);
  }
  uint8_t hash[SHA256_DIGEST_LENGTH];
  SHA256_Final(hash, &context);
  digest.hash = base::ToLowerASCII(base::HexEncode(hash));
  return digest;
}

std::optional<std::string> DetectedLanguage(std::string_view text) {
  constexpr size_t kSampleChars = 4096;
  constexpr float kMinProbability = 0.5;
  constexpr std::u16string_view kTraditional =
      u"這個們說來時會對為國學與後開發經還現種點長車門問間東見話題實際關係電體歷無";
  constexpr std::u16string_view kSimplified =
      u"这个们说来时会对为国学与后开发经还现种点长车门问间东见话题实际关系电体历无";
  std::u16string wide = base::UTF8ToUTF16(text);
  if (wide.size() > kSampleChars) {
    wide.resize(kSampleChars);
  }
  const std::string sample = base::UTF16ToUTF8(wide);
  chrome_lang_id::NNetLanguageIdentifier identifier(0, 1000);
  const chrome_lang_id::NNetLanguageIdentifier::Result found =
      identifier.FindLanguage(sample);
  const std::string& language = found.language;
  if (found.probability < kMinProbability ||
      language == chrome_lang_id::NNetLanguageIdentifier::kUnknown ||
      language == "und" || language.ends_with("-Latn")) {
    return std::nullopt;
  }
  if (language == "zh") {
    int traditional = 0;
    int simplified = 0;
    for (char16_t c : wide) {
      if (kTraditional.find(c) != std::u16string_view::npos) {
        ++traditional;
      } else if (kSimplified.find(c) != std::u16string_view::npos) {
        ++simplified;
      }
    }
    return traditional > simplified ? "zh-Hant" : "zh-Hans";
  }
  if (language == "iw") {
    return "he";
  }
  if (language == "fil") {
    return "tl";
  }
  if (language == "no") {
    return "nb";
  }
  if (language == "jw") {
    return "jv";
  }
  return language;
}

std::optional<Digest> GunzipInto(const base::FilePath& gzipped,
                                 const base::FilePath& target,
                                 int64_t size_limit) {
  base::File in(gzipped, base::File::FLAG_OPEN | base::File::FLAG_READ);
  base::File out(target,
                 base::File::FLAG_CREATE_ALWAYS | base::File::FLAG_WRITE);
  if (!in.IsValid() || !out.IsValid()) {
    return std::nullopt;
  }
  z_stream stream = {};
  if (inflateInit2(&stream, 16 + MAX_WBITS) != Z_OK) {
    return std::nullopt;
  }
  SHA256_CTX context;
  SHA256_Init(&context);
  Digest digest;
  std::vector<uint8_t> input(kChunk);
  std::vector<uint8_t> output(kChunk);
  int status = Z_OK;
  bool ok = true;
  while (ok && status != Z_STREAM_END) {
    std::optional<size_t> got = in.ReadAtCurrentPos(input);
    if (!got || *got == 0) {
      ok = false;
      break;
    }
    stream.next_in = input.data();
    stream.avail_in = static_cast<uInt>(*got);
    while (stream.avail_in > 0 && status != Z_STREAM_END) {
      stream.next_out = output.data();
      stream.avail_out = static_cast<uInt>(output.size());
      status = inflate(&stream, Z_NO_FLUSH);
      if (status != Z_OK && status != Z_STREAM_END) {
        ok = false;
        break;
      }
      const size_t produced = output.size() - stream.avail_out;
      digest.size += static_cast<int64_t>(produced);
      if (size_limit > 0 && digest.size > size_limit) {
        ok = false;
        break;
      }
      SHA256_Update(&context, output.data(), produced);
      if (produced &&
          !out.WriteAtCurrentPosAndCheck(base::span(output).first(produced))) {
        ok = false;
        break;
      }
    }
  }
  inflateEnd(&stream);
  ok = ok && out.Flush();
  out.Close();
  if (!ok) {
    base::DeleteFile(target);
    return std::nullopt;
  }
  uint8_t hash[SHA256_DIGEST_LENGTH];
  SHA256_Final(hash, &context);
  digest.hash = base::ToLowerASCII(base::HexEncode(hash));
  return digest;
}

}
