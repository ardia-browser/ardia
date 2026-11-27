#ifndef ARDIA_MAC_AC_MAC_WEBUI_POLICY_H_
#define ARDIA_MAC_AC_MAC_WEBUI_POLICY_H_

#include <optional>
#include <string_view>

namespace ardia_mac::webui_policy {

inline constexpr std::string_view kShellSwitch = "ardia-shell";
inline constexpr std::string_view kShellEnvironment = "ARDIA_SHELL";
inline constexpr std::string_view kWebUIValue = "webui";

enum class Build { kRelease, kDevelopment };

enum class Decision {
  kOff,
  kOnFromSwitch,
  kOnFromEnvironment,
  kRefusedInRelease,
  kOffBySwitch,
};

constexpr Build CompiledBuild() {
#if defined(ARDIA_MAC_WEBUI_DEV) && !defined(OFFICIAL_BUILD) && !defined(ARDIA_MAC_WEBUI_RELEASE)
  return Build::kDevelopment;
#else
  return Build::kRelease;
#endif
}

inline constexpr std::string_view kBootstrapAsset = "host-bootstrap.js";

constexpr bool ReadsSession(std::string_view asset) {
  return asset == kBootstrapAsset;
}

constexpr bool AsksForWebUI(std::optional<std::string_view> value) {
  return value.has_value() && *value == kWebUIValue;
}

constexpr Decision Decide(Build build,
                          std::optional<std::string_view> shell_switch,
                          std::optional<std::string_view> shell_environment) {
  if (build != Build::kDevelopment) {
    return AsksForWebUI(shell_switch) || AsksForWebUI(shell_environment)
               ? Decision::kRefusedInRelease
               : Decision::kOff;
  }
  if (shell_switch.has_value()) {
    return AsksForWebUI(shell_switch) ? Decision::kOnFromSwitch
                                      : Decision::kOffBySwitch;
  }
  return AsksForWebUI(shell_environment) ? Decision::kOnFromEnvironment
                                         : Decision::kOff;
}

constexpr bool Active(Decision decision) {
  return decision == Decision::kOnFromSwitch ||
         decision == Decision::kOnFromEnvironment;
}

inline constexpr std::string_view kBackgroundSwitch = "ardia-background";
inline constexpr std::string_view kBackgroundEnvironment = "ARDIA_BACKGROUND";

constexpr bool BackgroundValue(std::optional<std::string_view> value) {
  return value.has_value() && (*value == "1" || *value == "true");
}

constexpr bool Background(bool background_switch,
                          std::optional<std::string_view> background_environment) {
  return background_switch || BackgroundValue(background_environment);
}

constexpr bool ShouldStart(std::optional<std::string_view> shell_switch,
                           std::optional<std::string_view> shell_environment) {
  return Active(Decide(CompiledBuild(), shell_switch, shell_environment));
}

constexpr std::string_view Describe(Decision decision) {
  switch (decision) {
    case Decision::kOff:
      return "off";
    case Decision::kOnFromSwitch:
      return "on (--ardia-shell=webui)";
    case Decision::kOnFromEnvironment:
      return "on (ARDIA_SHELL=webui)";
    case Decision::kRefusedInRelease:
      return "refused: release builds never run the WebUI shell";
    case Decision::kOffBySwitch:
      return "off (--ardia-shell names another shell)";
  }
  return "off";
}

}

#endif
