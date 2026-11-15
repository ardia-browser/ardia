// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/keychain_records.h"

#include "base/base64.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "base/values.h"
#include "crypto/hash.h"

namespace ardia_linux {

SealKind SealKindOf(std::string_view ciphertext) {
  const std::string_view tag = ciphertext.substr(0, 3);
  if (tag == "v10") {
    return SealKind::kBasic;
  }
  if (tag == "v11") {
    return SealKind::kKeyring;
  }
  if (tag == "v12") {
    return SealKind::kPortal;
  }
  return SealKind::kUnknown;
}

std::string SealKindName(SealKind kind) {
  switch (kind) {
    case SealKind::kBasic:
      return "basic_text";
    case SealKind::kKeyring:
      return "secret_service";
    case SealKind::kPortal:
      return "secret_portal";
    case SealKind::kUnknown:
      return "unknown";
  }
}

bool IsKeyring(SealKind kind) {
  return kind == SealKind::kKeyring || kind == SealKind::kPortal;
}

bool NeedsResealing(SealKind stored, SealKind available) {
  return !IsKeyring(stored) && IsKeyring(available);
}

std::string RecordJson(const KeychainRecord& record) {
  base::DictValue value;
  value.Set("backend", record.backend);
  value.Set("sealed", true);
  value.Set("value", base::Base64Encode(record.ciphertext));
  return base::WriteJson(value).value_or("{}");
}

std::optional<KeychainRecord> RecordFromJson(std::string_view json) {
  std::optional<base::DictValue> value =
      base::JSONReader::ReadDict(json, base::JSON_PARSE_RFC);
  if (!value || !value->FindBool("sealed").value_or(false)) {
    return std::nullopt;
  }
  const std::string* backend = value->FindString("backend");
  const std::string* sealed = value->FindString("value");
  if (!sealed) {
    return std::nullopt;
  }
  KeychainRecord record;
  record.backend = backend ? *backend : std::string();
  if (!base::Base64Decode(*sealed, &record.ciphertext)) {
    return std::nullopt;
  }
  return record;
}

std::string ItemFileName(std::string_view account) {
  return base::HexEncodeLower(
             crypto::hash::Sha256(account)) +
         ".json";
}

}
