#ifndef ARDIA_WIN_WEBUI_DESKTOP_PLATFORM_WIN_H_
#define ARDIA_WIN_WEBUI_DESKTOP_PLATFORM_WIN_H_

#include <windows.h>

#include <optional>
#include <string>
#include <string_view>

#include "base/files/file_path.h"
#include "base/values.h"

namespace ardia_win {

inline constexpr std::string_view kDefaultBrowserCalls[] = {"ArdiaSystem.isDefaultBrowser",
                                                            "ArdiaSystem.setAsDefaultBrowser"};
inline constexpr std::string_view kLoginItemCalls[] = {"ArdiaSystem.launchAtLoginStatus",
                                                       "ArdiaSystem.setLaunchAtLogin"};
inline constexpr std::string_view kOpenExternalCalls[] = {"ArdiaApp.openExternalURL"};
inline constexpr wchar_t kLoginItemValue[] = L"Ardia WebUI";
inline constexpr size_t kExternalUrlLimit = 32 * 1024;

struct ShellDecorations {
  HRESULT backdrop = E_NOTIMPL;
  HRESULT corners = E_NOTIMPL;
  HRESULT dark_title = E_NOTIMPL;
  bool dark = false;
};

ShellDecorations ApplyShellDecorations(HWND window);

bool SystemPrefersDark();

bool PlainCodePoints(std::string_view text);

bool RawUserInfo(std::string_view text);

bool ExternalUrlAllowed(std::string_view text);

bool SecretAccountAllowed(std::string_view account);

std::string SecretFileName(std::string_view account);

int ExternalOpenCount();

int DefaultAppsOpenCount();

std::optional<std::wstring> LoginItemCommand(const base::FilePath& executable);

base::FilePath SecretDirectory();

base::DictValue SecretRoundTrip();

}

#endif
