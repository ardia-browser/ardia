// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_API_H_
#define ARDIA_LINUX_API_H_

#include "ardia/win/api.h"

namespace ardia_linux {

class ModuleRegistry;

inline constexpr char kEngineHostModule[] = "ArdiaEngineHost";

void RegisterEngineHostModule(ModuleRegistry& registry);

}

#endif
