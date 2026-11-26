// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_CORE_AC_TAB_DIAGNOSTICS_H_
#define ARDIA_CORE_AC_TAB_DIAGNOSTICS_H_

#include <string>

class GURL;

namespace content {
class WebContents;
}

namespace ardiacore {

void WatchTabDiagnostics(content::WebContents* contents);

std::string DiagnosticsUrl(const GURL& url);

}

#endif
