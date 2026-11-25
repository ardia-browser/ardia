// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_CONSOLE_RING_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_CONSOLE_RING_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>

#include "base/types/expected.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace ardia {

inline constexpr size_t kConsoleRingSize = 200;
inline constexpr size_t kConsoleDeltaMax = 200;

void InstallCliConsoleRing();

void WatchConsoleOf(content::WebContents* contents);

bool ContentsInspectable(content::WebContents* contents);

base::expected<base::DictValue, std::string> ConsoleDelta(
    content::WebContents* contents,
    uint64_t after,
    std::optional<double> generation,
    size_t limit);

base::DictValue ConsoleRingTotals();

}

#endif
