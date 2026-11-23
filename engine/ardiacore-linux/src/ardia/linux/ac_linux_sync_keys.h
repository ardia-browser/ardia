#ifndef ARDIA_LINUX_AC_LINUX_SYNC_KEYS_H_
#define ARDIA_LINUX_AC_LINUX_SYNC_KEYS_H_

#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

struct ardia_sync_keys;

namespace ardia::linux_sync {

using Bytes = std::vector<uint8_t>;

inline constexpr size_t kEntropyBytes = 32;
inline constexpr size_t kPhraseWords = 24;
inline constexpr size_t kLongestWord = 8;
inline constexpr size_t kTagLength = 26;
inline constexpr size_t kNonceBytes = 12;
inline constexpr size_t kTagBytes = 16;
inline constexpr size_t kFilePadding = 1024;
inline constexpr char kSyncCore[] = "rust";

void Wipe(void* data, size_t size);
void Wipe(Bytes& bytes);
void Wipe(std::string& text);

std::optional<Bytes> NewEntropy();
bool IsTag(std::string_view name);
std::string NewFileId();

std::string Base64Encode(const Bytes& data);
std::optional<Bytes> Base64Decode(std::string_view text);

enum class OpenError { kNone, kFormat, kAuthentication, kTooLarge, kOther };

std::string_view OpenFailureCode(OpenError error);

class SyncKeys {
 public:
  static std::unique_ptr<SyncKeys> Make(const Bytes& entropy);
  SyncKeys(const SyncKeys&) = delete;
  SyncKeys& operator=(const SyncKeys&) = delete;
  ~SyncKeys();

  const std::string& chain_tag() const { return chain_tag_; }
  std::string ScopeTag(std::string_view scope) const;

  std::optional<Bytes> Seal(const Bytes& payload, std::string_view scope_tag, std::string_view file_id) const;
  OpenError Open(const Bytes& file, std::string_view scope_tag, std::string_view file_id, Bytes* payload) const;

  std::optional<std::string> SealPassword(std::string_view password, std::string_view origin,
                                          std::string_view username) const;
  OpenError OpenPassword(std::string_view sealed, std::string_view origin, std::string_view username,
                         std::string* password) const;

 private:
  SyncKeys(ardia_sync_keys* handle, std::string chain_tag);

  ardia_sync_keys* handle_;
  std::string chain_tag_;
};

std::vector<std::string> PhraseWords(const Bytes& entropy);
std::vector<std::string> PhraseTokens(std::string_view text);

struct PhraseProblem {
  enum class Kind { kNone, kWordCount, kUnknownWord, kChecksum };
  Kind kind = Kind::kNone;
  size_t count = 0;
  std::string word;
};

PhraseProblem EntropyFromPhrase(std::string_view text, Bytes* entropy);

}

#endif
