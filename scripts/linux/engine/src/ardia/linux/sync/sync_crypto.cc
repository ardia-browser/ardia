// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/sync/sync_crypto.h"

#include <utility>

#include "base/base64.h"
#include "base/strings/string_util.h"
#include "third_party/boringssl/src/include/openssl/aead.h"
#include "third_party/boringssl/src/include/openssl/digest.h"
#include "third_party/boringssl/src/include/openssl/hkdf.h"
#include "third_party/boringssl/src/include/openssl/hmac.h"
#include "third_party/boringssl/src/include/openssl/mem.h"
#include "third_party/boringssl/src/include/openssl/rand.h"
#include "third_party/boringssl/src/include/openssl/sha.h"

namespace ardia_linux::sync {

namespace {

constexpr std::string_view kBase32Alphabet = "abcdefghijklmnopqrstuvwxyz234567";

const uint8_t* Bytes(std::string_view text) {
  return reinterpret_cast<const uint8_t*>(text.data());
}

std::string BigEndian32(size_t value) {
  const uint32_t n = static_cast<uint32_t>(value);
  return std::string{static_cast<char>(n >> 24), static_cast<char>(n >> 16),
                     static_cast<char>(n >> 8), static_cast<char>(n)};
}

Secret Hkdf32(std::string_view input, std::string_view info) {
  std::string out(32, '\0');
  if (!HKDF(reinterpret_cast<uint8_t*>(out.data()), out.size(), EVP_sha256(),
            Bytes(input), input.size(), Bytes(kSalt), kSalt.size(),
            Bytes(info), info.size())) {
    return Secret();
  }
  return Secret(std::move(out));
}

Secret Hmac(std::string_view key, std::initializer_list<std::string_view> parts) {
  HMAC_CTX context;
  HMAC_CTX_init(&context);
  std::string out(32, '\0');
  unsigned length = 0;
  bool ok = HMAC_Init_ex(&context, key.data(), key.size(), EVP_sha256(),
                         nullptr);
  for (std::string_view part : parts) {
    ok = ok && HMAC_Update(&context, Bytes(part), part.size());
  }
  ok = ok && HMAC_Final(&context, reinterpret_cast<uint8_t*>(out.data()),
                        &length);
  HMAC_CTX_cleanup(&context);
  return ok && length == 32 ? Secret(std::move(out)) : Secret();
}

std::optional<std::string> GcmSeal(std::string_view key,
                                   std::string_view nonce,
                                   std::string_view aad,
                                   std::string_view plain) {
  bssl::ScopedEVP_AEAD_CTX context;
  if (!EVP_AEAD_CTX_init(context.get(), EVP_aead_aes_256_gcm(), Bytes(key),
                         key.size(), kTagBytes, nullptr)) {
    return std::nullopt;
  }
  std::string out(plain.size() + kTagBytes, '\0');
  size_t written = 0;
  if (!EVP_AEAD_CTX_seal(context.get(), reinterpret_cast<uint8_t*>(out.data()),
                         &written, out.size(), Bytes(nonce), nonce.size(),
                         Bytes(plain), plain.size(), Bytes(aad), aad.size()) ||
      written != out.size()) {
    return std::nullopt;
  }
  return out;
}

std::optional<Secret> GcmOpen(std::string_view key,
                              std::string_view box,
                              std::string_view aad) {
  if (box.size() < kNonceBytes + kTagBytes) {
    return std::nullopt;
  }
  bssl::ScopedEVP_AEAD_CTX context;
  if (!EVP_AEAD_CTX_init(context.get(), EVP_aead_aes_256_gcm(), Bytes(key),
                         key.size(), kTagBytes, nullptr)) {
    return std::nullopt;
  }
  std::string_view nonce = box.substr(0, kNonceBytes);
  std::string_view sealed = box.substr(kNonceBytes);
  Secret plain(std::string(sealed.size(), '\0'));
  size_t written = 0;
  if (!EVP_AEAD_CTX_open(context.get(),
                         reinterpret_cast<uint8_t*>(plain.str().data()),
                         &written, plain.size(), Bytes(nonce), nonce.size(),
                         Bytes(sealed), sealed.size(), Bytes(aad),
                         aad.size())) {
    return std::nullopt;
  }
  plain.str().resize(written);
  return plain;
}

Secret Padded(std::string_view payload, size_t block) {
  const size_t length = 4 + payload.size();
  std::string plain(length + (block - length % block) % block, '\0');
  std::string prefix = BigEndian32(payload.size());
  plain.replace(0, 4, prefix);
  plain.replace(4, payload.size(), payload);
  return Secret(std::move(plain));
}

std::optional<Secret> Unpadded(const Secret& plain) {
  if (plain.size() < 4) {
    return std::nullopt;
  }
  const uint8_t* p = Bytes(plain.view());
  const size_t length = (size_t{p[0]} << 24) | (size_t{p[1]} << 16) |
                        (size_t{p[2]} << 8) | size_t{p[3]};
  if (length > plain.size() - 4) {
    return std::nullopt;
  }
  return Secret(std::string(plain.view().substr(4, length)));
}

std::string PasswordAad(std::string_view origin, std::string_view username) {
  std::string aad(kMagic);
  aad += "password/";
  aad += BigEndian32(origin.size());
  aad += origin;
  aad += username;
  return aad;
}

}

void Wipe(std::string& text) {
  if (text.capacity()) {
    text.resize(text.capacity());
    OPENSSL_cleanse(text.data(), text.size());
  }
  text.clear();
}

Secret::Secret() = default;
Secret::Secret(std::string bytes) : bytes_(std::move(bytes)) {}
Secret::Secret(Secret&& other) : bytes_(std::move(other.bytes_)) {
  Wipe(other.bytes_);
}
Secret& Secret::operator=(Secret&& other) {
  if (this != &other) {
    Wipe(bytes_);
    bytes_ = std::move(other.bytes_);
    Wipe(other.bytes_);
  }
  return *this;
}
Secret::~Secret() {
  Wipe(bytes_);
}

std::string Base32(base::span<const uint8_t> bytes) {
  std::string out;
  uint32_t buffer = 0;
  int bits = 0;
  for (uint8_t byte : bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out.push_back(kBase32Alphabet[(buffer >> (bits - 5)) & 31]);
      bits -= 5;
    }
    buffer &= (1u << bits) - 1;
  }
  if (bits > 0) {
    out.push_back(kBase32Alphabet[(buffer << (5 - bits)) & 31]);
  }
  return out;
}

bool IsTag(std::string_view name) {
  if (name.size() != 26) {
    return false;
  }
  for (char c : name) {
    if (kBase32Alphabet.find(c) == std::string_view::npos) {
      return false;
    }
  }
  return true;
}

std::optional<Secret> RandomSecret(size_t size) {
  std::string out(size, '\0');
  if (!RAND_bytes(reinterpret_cast<uint8_t*>(out.data()), out.size())) {
    return std::nullopt;
  }
  return Secret(std::move(out));
}

std::string NewFileId() {
  uint8_t random[16] = {};
  RAND_bytes(random, sizeof(random));
  return Base32(random);
}

std::string Sha256(std::string_view data) {
  std::string out(SHA256_DIGEST_LENGTH, '\0');
  SHA256(Bytes(data), data.size(), reinterpret_cast<uint8_t*>(out.data()));
  return out;
}

std::string Base64(std::string_view bytes) {
  return base::Base64Encode(bytes);
}

std::optional<Secret> FromBase64(std::string_view text) {
  std::string out;
  if (!base::Base64Decode(text, &out,
                          base::Base64DecodePolicy::kForgiving)) {
    Wipe(out);
    return std::nullopt;
  }
  return Secret(std::move(out));
}

bool IsUtf8(std::string_view text) {
  return base::IsStringUTF8AllowingNoncharacters(text);
}

Keys::Keys() = default;
Keys::Keys(Keys&&) = default;
Keys& Keys::operator=(Keys&&) = default;
Keys::~Keys() = default;

std::optional<Keys> Keys::Derive(std::string_view entropy) {
  if (entropy.size() != kKeyBytes) {
    return std::nullopt;
  }
  Keys keys;
  keys.file_ = Hkdf32(entropy, "file-key");
  keys.name_ = Hkdf32(entropy, "name-key");
  keys.password_ = Hkdf32(entropy, "password-key");
  keys.password_nonce_ = Hkdf32(entropy, "password-nonce-key");
  if (keys.file_.empty() || keys.name_.empty() || keys.password_.empty() ||
      keys.password_nonce_.empty()) {
    return std::nullopt;
  }
  keys.chain_tag_ = keys.Tag("chain");
  if (keys.chain_tag_.empty()) {
    return std::nullopt;
  }
  return keys;
}

std::string Keys::Tag(std::string_view label) const {
  Secret mac = Hmac(name_.view(), {label});
  if (mac.empty()) {
    return std::string();
  }
  return Base32(base::span(Bytes(mac.view()), 16u));
}

std::string Keys::ScopeTag(std::string_view scope) const {
  return Tag(std::string("scope/") + std::string(scope));
}

std::string Keys::FileAad(std::string_view scope_tag,
                          std::string_view file_id) const {
  std::string aad(kMagic);
  aad += chain_tag_;
  aad += "/";
  aad += scope_tag;
  aad += "/";
  aad += file_id;
  return aad;
}

std::optional<std::string> Keys::Seal(std::string_view payload,
                                      std::string_view scope_tag,
                                      std::string_view file_id) const {
  Secret plain = Padded(payload, kFilePadding);
  std::optional<Secret> nonce = RandomSecret(kNonceBytes);
  if (!nonce) {
    return std::nullopt;
  }
  std::optional<std::string> sealed = GcmSeal(
      file_.view(), nonce->view(), FileAad(scope_tag, file_id), plain.view());
  if (!sealed) {
    return std::nullopt;
  }
  std::string file(kMagic);
  file += nonce->view();
  file += *sealed;
  return file;
}

std::optional<Secret> Keys::Open(std::string_view file,
                                 std::string_view scope_tag,
                                 std::string_view file_id) const {
  if (file.size() < kMagic.size() + kNonceBytes + kTagBytes + 4 ||
      file.substr(0, kMagic.size()) != kMagic) {
    return std::nullopt;
  }
  std::optional<Secret> plain = GcmOpen(
      file_.view(), file.substr(kMagic.size()), FileAad(scope_tag, file_id));
  if (!plain) {
    return std::nullopt;
  }
  return Unpadded(*plain);
}

std::optional<std::string> Keys::SealPassword(std::string_view password,
                                              std::string_view origin,
                                              std::string_view username) const {
  Secret plain = Padded(password, kPasswordPadding);
  const std::string aad = PasswordAad(origin, username);
  Secret synthetic = Hmac(password_nonce_.view(),
                          {BigEndian32(aad.size()), aad, plain.view()});
  if (synthetic.empty()) {
    return std::nullopt;
  }
  std::string_view nonce = synthetic.view().substr(0, kNonceBytes);
  std::optional<std::string> sealed =
      GcmSeal(password_.view(), nonce, aad, plain.view());
  if (!sealed) {
    return std::nullopt;
  }
  Secret out(std::string(1, static_cast<char>(kPasswordVersion)));
  out.str() += nonce;
  out.str() += *sealed;
  Wipe(*sealed);
  return Base64(out.view());
}

std::optional<Secret> Keys::OpenPassword(std::string_view sealed,
                                         std::string_view origin,
                                         std::string_view username) const {
  std::optional<Secret> data = FromBase64(sealed);
  if (!data || data->size() < 1 + kNonceBytes + kTagBytes + 4 ||
      static_cast<uint8_t>(data->view()[0]) != kPasswordVersion) {
    return std::nullopt;
  }
  std::optional<Secret> plain = GcmOpen(
      password_.view(), data->view().substr(1), PasswordAad(origin, username));
  if (!plain) {
    return std::nullopt;
  }
  std::optional<Secret> password = Unpadded(*plain);
  if (!password || !IsUtf8(password->view())) {
    return std::nullopt;
  }
  return password;
}

}
