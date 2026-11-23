#ifndef ARDIA_WIN_WEBUI_WEBUI_SHELL_H_
#define ARDIA_WIN_WEBUI_WEBUI_SHELL_H_

#include "base/win/windows_types.h"

namespace ardia_win {

void RegisterWebUIShell();

void OpenWebUIShell();

void CloseWebUIShell();

bool WebUIShellPreTranslate(const MSG& msg);

}

#endif
