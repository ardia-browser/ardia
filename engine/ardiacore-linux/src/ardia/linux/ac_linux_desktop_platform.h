#ifndef ARDIA_LINUX_AC_LINUX_DESKTOP_PLATFORM_H_
#define ARDIA_LINUX_AC_LINUX_DESKTOP_PLATFORM_H_

#include <optional>
#include <string_view>

#include "ardia/desktop/ac_desktop_platform.h"

namespace ardia::linux_desktop_platform {

inline constexpr std::string_view kDefaultBrowserCalls[] = {"ArdiaSystem.isDefaultBrowser",
                                                            "ArdiaSystem.setAsDefaultBrowser"};
inline constexpr std::string_view kLoginItemCalls[] = {"ArdiaSystem.launchAtLoginStatus", "ArdiaSystem.setLaunchAtLogin"};
inline constexpr std::string_view kOpenExternalCalls[] = {"ArdiaApp.openExternalURL"};

std::optional<desktop::PlatformCapability> CapabilityForMethod(std::string_view method);

}

#endif
