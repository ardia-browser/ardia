#ifndef ARDIA_MAC_AC_MAC_SHARE_H_
#define ARDIA_MAC_AC_MAC_SHARE_H_

#include <string>
#include <string_view>
#include <vector>

#include "ardia/mac/ac_mac_shell_host.h"
#include "base/values.h"

namespace ardia_mac::share {

struct Service {
  std::string title;
  std::string menu_title;
};

bool Handles(std::string_view method);
void AppendCapabilities(base::ListValue& capabilities);
void Invoke(ShellHostView& host,
            const std::string& method,
            const base::ListValue* values,
            ShellHostView::Done done);
std::vector<Service> LinkServices();
void Retire(const std::string& owner);
void RetireBinding(const std::string& owner, int binding);
void OpenSharingSettingsFromMenu();
void InstallPageMenu();

}

#endif
