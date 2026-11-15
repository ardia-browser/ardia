// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_OWNER_CHECK_H_
#define ARDIA_LINUX_MODULES_OWNER_CHECK_H_

#include <string>

#include "base/functional/callback.h"

namespace ardia_linux {

class ModuleRegistry;

void ConfirmDeviceOwner(const std::string& reason,
                        base::OnceCallback<void(bool granted)> done);

int OwnerPresence();

bool OwnerStillPresent(int presence);

void WhenOwnerAway(base::RepeatingClosure listener);

void RegisterOwnerCheck(ModuleRegistry& registry);

}

#endif
