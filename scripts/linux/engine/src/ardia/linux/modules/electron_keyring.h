// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_ELECTRON_KEYRING_H_
#define ARDIA_LINUX_MODULES_ELECTRON_KEYRING_H_

#include <optional>
#include <string>
#include <vector>

namespace ardia_linux {

std::optional<std::string> ElectronKeyringPassword(
    const std::vector<std::string>& applications);

}

#endif
