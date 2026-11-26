// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_DEVTOOLS_SESSIONS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_DEVTOOLS_SESSIONS_H_

#include <cstddef>
#include <string_view>

namespace ardia {

size_t LiveCliDevToolsSessions();

int CloseCliDevToolsSessionsOf(std::string_view owner);

void CloseAllCliDevToolsSessions();

}

#endif
