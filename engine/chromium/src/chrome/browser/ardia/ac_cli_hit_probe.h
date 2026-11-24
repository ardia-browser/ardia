// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_HIT_PROBE_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_HIT_PROBE_H_

#include <optional>

#include "base/functional/callback_helpers.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_page_signals.h"

namespace content {
class WebContents;
}

namespace ardia {

inline constexpr double kMaxHitCoordinate = 1e6;

base::ScopedClosureRunner StartHitProbe(content::WebContents* contents,
                                        double x,
                                        double y,
                                        std::optional<int> target,
                                        PageSignalReply reply);

base::DictValue HitProbeTotals();

}

#endif
