// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_SYNC_SYNC_LOGINS_H_
#define ARDIA_LINUX_SYNC_SYNC_LOGINS_H_

#include <optional>
#include <string>
#include <string_view>

#include "ardia/linux/sync/sync_crypto.h"
#include "base/values.h"

namespace ardia_linux::sync {

void CleanseValue(base::Value& value);

std::optional<std::string> HidePasswords(std::string_view json,
                                         const Keys& keys);

std::optional<Secret> RestorePasswords(std::string_view json,
                                       const Keys& keys);

std::optional<std::string> LoginOrigin(std::string_view realm);

std::optional<base::ListValue> SealedLogins(std::string_view reply,
                                            const Keys& keys);

std::optional<Secret> SavedPassword(std::string_view reply,
                                    std::string_view origin,
                                    std::string_view username);

Secret LoginArgs(std::string_view origin,
                 std::string_view username,
                 std::optional<std::string_view> password);

}

#endif
