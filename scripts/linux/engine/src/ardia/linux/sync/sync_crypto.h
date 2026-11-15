// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_SYNC_SYNC_CRYPTO_H_
#define ARDIA_LINUX_SYNC_SYNC_CRYPTO_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/containers/span.h"

namespace ardia_linux::sync {

inline constexpr size_t kKeyBytes = 32;
inline constexpr size_t kNonceBytes = 12;
inline constexpr size_t kTagBytes = 16;
inline constexpr size_t kFilePadding = 1024;
inline constexpr size_t kPasswordPadding = 32;
inline constexpr uint8_t kPasswordVersion = 1;
inline constexpr std::string_view kMagic = "NNS1";
inline constexpr std::string_view kSalt = "netnyahoo-sync/v1";
inline constexpr std::string_view kFileExtension = ".nns";

class Secret {
 public:
  Secret();
  explicit Secret(std::string bytes);
  Secret(Secret&& other);
  Secret& operator=(Secret&& other);
  Secret(const Secret&) = delete;
  Secret& operator=(const Secret&) = delete;
  ~Secret();

  const std::string& str() const { return bytes_; }
  std::string& str() { return bytes_; }
  std::string_view view() const { return bytes_; }
  size_t size() const { return bytes_.size(); }
  bool empty() const { return bytes_.empty(); }

 private:
  std::string bytes_;
};

void Wipe(std::string& text);

std::string Base32(base::span<const uint8_t> bytes);
bool IsTag(std::string_view name);
std::string NewFileId();
std::optional<Secret> RandomSecret(size_t size);
std::string Sha256(std::string_view data);
std::string Base64(std::string_view bytes);
std::optional<Secret> FromBase64(std::string_view text);
bool IsUtf8(std::string_view text);

class Keys {
 public:
  static std::optional<Keys> Derive(std::string_view entropy);

  Keys(Keys&&);
  Keys& operator=(Keys&&);
  ~Keys();

  const std::string& chain_tag() const { return chain_tag_; }
  std::string Tag(std::string_view label) const;
  std::string ScopeTag(std::string_view scope) const;

  std::optional<std::string> Seal(std::string_view payload,
                                  std::string_view scope_tag,
                                  std::string_view file_id) const;
  std::optional<Secret> Open(std::string_view file,
                             std::string_view scope_tag,
                             std::string_view file_id) const;

  std::optional<std::string> SealPassword(std::string_view password,
                                          std::string_view origin,
                                          std::string_view username) const;
  std::optional<Secret> OpenPassword(std::string_view sealed,
                                     std::string_view origin,
                                     std::string_view username) const;

 private:
  Keys();

  std::string FileAad(std::string_view scope_tag,
                      std::string_view file_id) const;

  Secret file_;
  Secret name_;
  Secret password_;
  Secret password_nonce_;
  std::string chain_tag_;
};

}

#endif
