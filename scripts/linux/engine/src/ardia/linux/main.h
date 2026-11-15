// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MAIN_H_
#define ARDIA_LINUX_MAIN_H_

#include "ardia/linux/main_delegate.h"

namespace ardia_linux {

inline constexpr char kUiDirSwitch[] = "ardia-ui-dir";
inline constexpr char kFeedbackUrlSwitch[] = "ardia-feedback-url";
inline constexpr char kSandboxDecisionSwitch[] = "ardia-sandbox-decision";

void BeforeChromeMain();

const char* TestGateDecision();

bool TestGateAsked();

}

#endif
