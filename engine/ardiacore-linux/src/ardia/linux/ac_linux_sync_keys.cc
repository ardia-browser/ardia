#include "ardia/linux/ac_linux_sync_keys.h"

#include <algorithm>
#include <cstring>
#include <utility>

#include "ardia/core_rs/include/ardia_core.h"

namespace ardia::linux_sync {
namespace {

static_assert(kEntropyBytes == ARDIA_ENTROPY_BYTES);

constexpr char kBase64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
constexpr char kUnknownToken[] = "x";
constexpr std::string_view kUnknownWordCode = "\"code\":\"unknownWord\"";
constexpr std::string_view kIndexKey = "\"index\":";

class CoreBuf {
 public:
  CoreBuf() = default;
  CoreBuf(const CoreBuf&) = delete;
  CoreBuf& operator=(const CoreBuf&) = delete;
  ~CoreBuf() { ardia_buf_free(&buf_); }

  ardia_buf* out() { return &buf_; }
  size_t size() const { return buf_.len; }
  std::string_view text() const {
    return buf_.len ? std::string_view(reinterpret_cast<const char*>(buf_.ptr), buf_.len) : std::string_view();
  }
  Bytes bytes() const { return buf_.len ? Bytes(buf_.ptr, buf_.ptr + buf_.len) : Bytes(); }

 private:
  ardia_buf buf_{nullptr, 0};
};

const uint8_t* In(std::string_view text) {
  return reinterpret_cast<const uint8_t*>(text.data());
}

OpenError ErrorOf(ardia_status status) {
  switch (status) {
    case ARDIA_STATUS_OK:
      return OpenError::kNone;
    case ARDIA_STATUS_FORMAT:
      return OpenError::kFormat;
    case ARDIA_STATUS_AUTHENTICATION:
      return OpenError::kAuthentication;
    case ARDIA_STATUS_TOO_LARGE:
      return OpenError::kTooLarge;
    default:
      return OpenError::kOther;
  }
}

bool CanBeListWord(std::string_view token) {
  return !token.empty() && token.size() <= kLongestWord &&
         std::all_of(token.begin(), token.end(), [](char c) { return c >= 'a' && c <= 'z'; });
}

std::optional<size_t> UnknownWordIndex(std::string_view detail) {
  if (detail.find(kUnknownWordCode) == std::string_view::npos) return std::nullopt;
  const size_t at = detail.find(kIndexKey);
  if (at == std::string_view::npos) return std::nullopt;
  size_t index = 0;
  size_t digits = 0;
  for (size_t i = at + kIndexKey.size(); i < detail.size() && detail[i] >= '0' && detail[i] <= '9'; ++i, ++digits) {
    index = index * 10 + static_cast<size_t>(detail[i] - '0');
    if (index >= kPhraseWords) return std::nullopt;
  }
  if (digits == 0) return std::nullopt;
  return index;
}

bool SeparatorPoint(uint32_t point) {
  if (point < 0x80) return !(point >= 'a' && point <= 'z');
  if (point < 0xc0 || point == 0xd7 || point == 0xf7) return true;
  if (point >= 0x2000 && point <= 0x2bff) return true;
  if (point >= 0x3000 && point <= 0x303f) return true;
  if (point >= 0xfe30 && point <= 0xfe4f) return true;
  if (point >= 0xff00 && point <= 0xff20) return true;
  return point == 0xfeff;
}

}

void Wipe(void* data, size_t size) {
  if (!data || !size) return;
  std::memset(data, 0, size);
  __asm__ __volatile__("" : : "r"(data) : "memory");
}

void Wipe(Bytes& bytes) {
  Wipe(bytes.data(), bytes.size());
}

void Wipe(std::string& text) {
  Wipe(text.data(), text.size());
}

std::optional<Bytes> NewEntropy() {
  CoreBuf entropy;
  if (ardia_phrase_generate_entropy(entropy.out()) != ARDIA_STATUS_OK || entropy.size() != kEntropyBytes)
    return std::nullopt;
  return entropy.bytes();
}

bool IsTag(std::string_view name) {
  return name.size() == kTagLength &&
         std::all_of(name.begin(), name.end(), [](char c) { return (c >= 'a' && c <= 'z') || (c >= '2' && c <= '7'); });
}

std::string NewFileId() {
  CoreBuf id;
  if (ardia_sync_new_file_id(id.out()) != ARDIA_STATUS_OK || !IsTag(id.text())) return std::string();
  return std::string(id.text());
}

std::string Base64Encode(const Bytes& data) {
  std::string out;
  out.reserve((data.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < data.size(); i += 3) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out.push_back(kBase64[(n >> 18) & 63]);
    out.push_back(kBase64[(n >> 12) & 63]);
    out.push_back(kBase64[(n >> 6) & 63]);
    out.push_back(kBase64[n & 63]);
  }
  if (i + 1 == data.size()) {
    const uint32_t n = data[i] << 16;
    out.push_back(kBase64[(n >> 18) & 63]);
    out.push_back(kBase64[(n >> 12) & 63]);
    out.append("==");
  } else if (i + 2 == data.size()) {
    const uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
    out.push_back(kBase64[(n >> 18) & 63]);
    out.push_back(kBase64[(n >> 12) & 63]);
    out.push_back(kBase64[(n >> 6) & 63]);
    out.push_back('=');
  }
  return out;
}

std::optional<Bytes> Base64Decode(std::string_view text) {
  if (text.size() % 4 != 0) return std::nullopt;
  auto value = [](char c) -> int {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
  };
  Bytes out;
  out.reserve(text.size() / 4 * 3);
  for (size_t i = 0; i < text.size(); i += 4) {
    const bool last = i + 4 == text.size();
    const int pad = last ? (text[i + 3] == '=') + (text[i + 2] == '=') : 0;
    if (pad == 1 && text[i + 2] == '=') return std::nullopt;
    uint32_t n = 0;
    for (int k = 0; k < 4; ++k) {
      if (k >= 4 - pad) {
        n <<= 6;
        continue;
      }
      const int v = value(text[i + k]);
      if (v < 0) return std::nullopt;
      n = (n << 6) | static_cast<uint32_t>(v);
    }
    out.push_back(static_cast<uint8_t>((n >> 16) & 0xff));
    if (pad < 2) out.push_back(static_cast<uint8_t>((n >> 8) & 0xff));
    if (pad < 1) out.push_back(static_cast<uint8_t>(n & 0xff));
  }
  return out;
}

std::string_view OpenFailureCode(OpenError error) {
  switch (error) {
    case OpenError::kNone:
      return std::string_view();
    case OpenError::kFormat:
      return "format";
    case OpenError::kAuthentication:
      return "authentication";
    case OpenError::kTooLarge:
      return "too_large";
    case OpenError::kOther:
      return "other";
  }
  return "other";
}

std::unique_ptr<SyncKeys> SyncKeys::Make(const Bytes& entropy) {
  if (entropy.size() != kEntropyBytes) return nullptr;
  ardia_sync_keys* handle = nullptr;
  if (ardia_sync_keys_new(entropy.data(), entropy.size(), &handle) != ARDIA_STATUS_OK || !handle) return nullptr;
  CoreBuf chain;
  if (ardia_sync_chain_tag(handle, chain.out()) != ARDIA_STATUS_OK || !IsTag(chain.text())) {
    ardia_sync_keys_free(handle);
    return nullptr;
  }
  return std::unique_ptr<SyncKeys>(new SyncKeys(handle, std::string(chain.text())));
}

SyncKeys::SyncKeys(ardia_sync_keys* handle, std::string chain_tag)
    : handle_(handle), chain_tag_(std::move(chain_tag)) {}

SyncKeys::~SyncKeys() {
  ardia_sync_keys_free(handle_);
}

std::string SyncKeys::ScopeTag(std::string_view scope) const {
  CoreBuf tag;
  if (ardia_sync_scope_tag(handle_, In(scope), scope.size(), tag.out()) != ARDIA_STATUS_OK || !IsTag(tag.text()))
    return std::string();
  return std::string(tag.text());
}

std::optional<Bytes> SyncKeys::Seal(const Bytes& payload, std::string_view scope_tag, std::string_view file_id) const {
  CoreBuf sealed;
  if (ardia_sync_seal(handle_, payload.data(), payload.size(), In(scope_tag), scope_tag.size(), In(file_id),
                      file_id.size(), sealed.out()) != ARDIA_STATUS_OK)
    return std::nullopt;
  return sealed.bytes();
}

OpenError SyncKeys::Open(const Bytes& file, std::string_view scope_tag, std::string_view file_id,
                         Bytes* payload) const {
  CoreBuf opened;
  const OpenError error = ErrorOf(ardia_sync_open(handle_, file.data(), file.size(), In(scope_tag), scope_tag.size(),
                                                  In(file_id), file_id.size(), opened.out()));
  if (error == OpenError::kNone) *payload = opened.bytes();
  return error;
}

std::optional<std::string> SyncKeys::SealPassword(std::string_view password, std::string_view origin,
                                                  std::string_view username) const {
  CoreBuf sealed;
  if (ardia_sync_seal_password(handle_, In(password), password.size(), In(origin), origin.size(), In(username),
                               username.size(), sealed.out()) != ARDIA_STATUS_OK)
    return std::nullopt;
  return std::string(sealed.text());
}

OpenError SyncKeys::OpenPassword(std::string_view sealed, std::string_view origin, std::string_view username,
                                 std::string* password) const {
  CoreBuf opened;
  const OpenError error = ErrorOf(ardia_sync_open_password(handle_, In(sealed), sealed.size(), In(origin),
                                                           origin.size(), In(username), username.size(),
                                                           opened.out()));
  if (error == OpenError::kNone) password->assign(opened.text());
  return error;
}

std::vector<std::string> PhraseWords(const Bytes& entropy) {
  std::vector<std::string> words;
  if (entropy.size() != kEntropyBytes) return words;
  CoreBuf phrase;
  if (ardia_phrase_from_entropy(entropy.data(), entropy.size(), phrase.out()) != ARDIA_STATUS_OK) return words;
  words.reserve(kPhraseWords);
  std::string_view rest = phrase.text();
  while (!rest.empty()) {
    const size_t space = rest.find(' ');
    words.emplace_back(rest.substr(0, space));
    rest = space == std::string_view::npos ? std::string_view() : rest.substr(space + 1);
  }
  if (words.size() != kPhraseWords) {
    for (auto& word : words) Wipe(word);
    words.clear();
  }
  return words;
}

std::vector<std::string> PhraseTokens(std::string_view text) {
  std::vector<std::string> tokens;
  std::string current;
  size_t i = 0;
  auto flush = [&] {
    if (!current.empty()) tokens.push_back(std::move(current));
    current.clear();
  };
  while (i < text.size()) {
    const uint8_t lead = static_cast<uint8_t>(text[i]);
    size_t length = 1;
    uint32_t point = lead;
    if (lead >= 0x80) {
      length = (lead & 0xe0) == 0xc0 ? 2 : (lead & 0xf0) == 0xe0 ? 3 : (lead & 0xf8) == 0xf0 ? 4 : 1;
      if (length == 1 || i + length > text.size()) {
        flush();
        ++i;
        continue;
      }
      point = lead & (0x7f >> length);
      for (size_t k = 1; k < length; ++k) point = (point << 6) | (static_cast<uint8_t>(text[i + k]) & 0x3f);
    } else if (lead >= 'A' && lead <= 'Z') {
      point = lead - 'A' + 'a';
    }
    if (SeparatorPoint(point)) {
      flush();
    } else if (length == 1) {
      current.push_back(static_cast<char>(point));
    } else {
      current.append(text.substr(i, length));
    }
    i += length;
  }
  flush();
  return tokens;
}

PhraseProblem EntropyFromPhrase(std::string_view text, Bytes* entropy) {
  PhraseProblem problem;
  std::vector<std::string> tokens = PhraseTokens(text);
  if (tokens.size() != kPhraseWords) {
    problem.kind = PhraseProblem::Kind::kWordCount;
    problem.count = tokens.size();
    for (auto& token : tokens) Wipe(token);
    return problem;
  }
  std::string words;
  words.reserve(kPhraseWords * (kLongestWord + 1));
  for (const auto& token : tokens) {
    if (!words.empty()) words.push_back(' ');
    words.append(CanBeListWord(token) ? std::string_view(token) : std::string_view(kUnknownToken));
  }
  CoreBuf out;
  const ardia_status status = ardia_phrase_to_entropy(In(words), words.size(), out.out());
  Wipe(words);
  if (status == ARDIA_STATUS_OK && out.size() == kEntropyBytes) {
    Wipe(*entropy);
    *entropy = out.bytes();
  } else if (const auto index = status == ARDIA_STATUS_PHRASE ? UnknownWordIndex(out.text()) : std::nullopt) {
    problem.kind = PhraseProblem::Kind::kUnknownWord;
    problem.word = tokens[*index];
  } else {
    problem.kind = PhraseProblem::Kind::kChecksum;
  }
  for (auto& token : tokens) Wipe(token);
  return problem;
}

}
