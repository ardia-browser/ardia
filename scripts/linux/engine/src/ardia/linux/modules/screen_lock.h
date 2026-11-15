// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_SCREEN_LOCK_H_
#define ARDIA_LINUX_MODULES_SCREEN_LOCK_H_

#include "base/files/file_path.h"
#include "base/functional/callback.h"

namespace ardia_linux {

class ModuleRegistry;

void WhenOwnerLeaves(base::RepeatingClosure listener);

void RegisterSystemSignalsModule(ModuleRegistry& registry);

base::FilePath FreeNameIn(const base::FilePath& folder,
                          const base::FilePath& name);

}

#endif
