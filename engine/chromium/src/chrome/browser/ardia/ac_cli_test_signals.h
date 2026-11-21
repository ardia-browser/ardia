// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TEST_SIGNALS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TEST_SIGNALS_H_

#include "base/time/time.h"
#include "base/values.h"

namespace ardia {

inline constexpr base::TimeDelta kHeldPluginInput = base::Seconds(2);
inline constexpr base::TimeDelta kHeldPluginDetach = base::Seconds(5);

void NoteCliPrivatePasteboard(bool active);
bool CliPrivatePasteboardActive();
void NoteCliPluginInputHold(bool active);
bool CliPluginInputHold();
void CountPluginDeliveryRefusedDeparted();
void AddCliTestSignals(base::DictValue& status);

}

#endif
