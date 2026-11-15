// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_ELECTRON_SECRETS_H_
#define ARDIA_LINUX_MODULES_ELECTRON_SECRETS_H_

#include <map>
#include <optional>
#include <string>
#include <string_view>

namespace ardia_linux {

inline constexpr char kElectronSecretsFile[] = "Secrets.json";
inline constexpr char kElectronSecretsMigrated[] = "Secrets.electron.json";
inline constexpr char kElectronBasicPassword[] = "peanuts";

struct ElectronSecret {
  std::string backend;
  bool sealed = false;
  std::string bytes;
};

std::map<std::string, ElectronSecret> ParseElectronSecrets(std::string_view json);

bool NeedsKeyringPassword(const ElectronSecret& secret);

std::optional<std::string> OpenElectronSecret(
    const ElectronSecret& secret,
    const std::optional<std::string>& keyring_password);

std::string SealLikeElectron(std::string_view plaintext,
                             std::string_view tag,
                             std::string_view password);

}

#endif
