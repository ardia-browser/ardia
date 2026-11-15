// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_KEYCHAIN_RECORDS_H_
#define ARDIA_LINUX_MODULES_KEYCHAIN_RECORDS_H_

#include <optional>
#include <string>
#include <string_view>

namespace ardia_linux {

enum class SealKind { kUnknown, kBasic, kKeyring, kPortal };

SealKind SealKindOf(std::string_view ciphertext);

std::string SealKindName(SealKind kind);

bool IsKeyring(SealKind kind);

bool NeedsResealing(SealKind stored, SealKind available);

struct KeychainRecord {
  std::string backend;
  std::string ciphertext;
};

std::string RecordJson(const KeychainRecord& record);

std::optional<KeychainRecord> RecordFromJson(std::string_view json);

std::string ItemFileName(std::string_view account);

}

#endif
