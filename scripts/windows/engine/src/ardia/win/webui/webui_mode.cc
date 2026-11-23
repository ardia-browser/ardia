#include "ardia/win/webui/webui_mode.h"

#include "base/command_line.h"

namespace ardia_win {

namespace {

std::wstring Trimmed(std::wstring path) {
  while (!path.empty() && (path.back() == L'\\' || path.back() == L'/')) {
    path.pop_back();
  }
  return path;
}

}

bool WebUIShellRequested(const base::CommandLine& command_line) {
  return command_line.GetSwitchValueASCII(kShellSwitch) == kWebUIShell;
}

std::wstring WebUIAppDataDirectory(const std::wstring& ardia_data_dir,
                                   const std::wstring& local_app_data) {
  const std::wstring scratch = Trimmed(ardia_data_dir);
  if (!scratch.empty()) {
    return scratch;
  }
  const std::wstring local = Trimmed(local_app_data);
  if (local.empty()) {
    return std::wstring();
  }
  return local + L"\\" + kWebUIAppDataFolder;
}

std::wstring WebUIUserDataDirectory(const std::wstring& app_data_dir) {
  if (app_data_dir.empty()) {
    return std::wstring();
  }
  return Trimmed(app_data_dir) + L"\\" + kWebUIChromiumFolder;
}

}
