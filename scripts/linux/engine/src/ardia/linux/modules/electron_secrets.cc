// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/electron_secrets.h"

#include <array>
#include <vector>

#include "base/base64.h"
#include "base/containers/span.h"
#include "base/json/json_reader.h"
#include "base/values.h"
#include "crypto/aes_cbc.h"
#include "third_party/boringssl/src/include/openssl/evp.h"

namespace ardia_linux {

namespace {

constexpr char kSalt[] = "saltysalt";
constexpr size_t kKeyBytes = 16;
constexpr std::string_view kBasicTag = "v10";
constexpr std::string_view kKeyringTag = "v11";

std::array<uint8_t, kKeyBytes> KeyFrom(std::string_view password) {
  std::array<uint8_t, kKeyBytes> key = {};
  PKCS5_PBKDF2_HMAC_SHA1(password.data(), password.size(),
                         reinterpret_cast<const uint8_t*>(kSalt),
                         sizeof(kSalt) - 1, 1, key.size(), key.data());
  return key;
}

std::array<uint8_t, crypto::aes_cbc::kBlockSize> Iv() {
  std::array<uint8_t, crypto::aes_cbc::kBlockSize> iv;
  iv.fill(' ');
  return iv;
}

}

std::map<std::string, ElectronSecret> ParseElectronSecrets(
    std::string_view json) {
  std::map<std::string, ElectronSecret> secrets;
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!parsed) {
    return secrets;
  }
  for (const auto [account, value] : *parsed) {
    const base::DictValue* stored = value.GetIfDict();
    const std::string* encoded = stored ? stored->FindString("value") : nullptr;
    if (!encoded) {
      continue;
    }
    ElectronSecret secret;
    if (const std::string* backend = stored->FindString("backend")) {
      secret.backend = *backend;
    }
    secret.sealed = stored->FindBool("sealed").value_or(false);
    if (!base::Base64Decode(*encoded, &secret.bytes)) {
      continue;
    }
    secrets.emplace(account, std::move(secret));
  }
  return secrets;
}

bool NeedsKeyringPassword(const ElectronSecret& secret) {
  return secret.sealed && secret.bytes.starts_with(kKeyringTag);
}

std::optional<std::string> OpenElectronSecret(
    const ElectronSecret& secret,
    const std::optional<std::string>& keyring_password) {
  if (!secret.sealed) {
    return secret.bytes;
  }
  std::string_view bytes(secret.bytes);
  std::string password;
  if (bytes.starts_with(kBasicTag)) {
    password = kElectronBasicPassword;
  } else if (bytes.starts_with(kKeyringTag) && keyring_password) {
    password = *keyring_password;
  } else {
    return std::nullopt;
  }
  bytes.remove_prefix(3);
  std::optional<std::vector<uint8_t>> plain = crypto::aes_cbc::Decrypt(
      KeyFrom(password), Iv(), base::as_byte_span(bytes));
  if (!plain) {
    return std::nullopt;
  }
  return std::string(plain->begin(), plain->end());
}

std::string SealLikeElectron(std::string_view plaintext,
                             std::string_view tag,
                             std::string_view password) {
  std::vector<uint8_t> sealed = crypto::aes_cbc::Encrypt(
      KeyFrom(password), Iv(), base::as_byte_span(plaintext));
  return std::string(tag) + std::string(sealed.begin(), sealed.end());
}

}
