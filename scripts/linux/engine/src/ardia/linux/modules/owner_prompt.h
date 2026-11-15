// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_OWNER_PROMPT_H_
#define ARDIA_LINUX_MODULES_OWNER_PROMPT_H_

#include <memory>

namespace ardia_linux {

class OwnerPromptUi;

std::unique_ptr<OwnerPromptUi> CreateWindowOwnerPromptUi();

}

#endif
