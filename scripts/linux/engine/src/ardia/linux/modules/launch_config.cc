// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/launch_config.h"

#include <algorithm>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/linux/test_gate.h"
#include "base/command_line.h"
#include "base/environment.h"
#include "base/no_destructor.h"
#include "base/nix/xdg_util.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"

namespace ardia_linux {

namespace {

constexpr char kFeedbackUrlSwitchName[] = "ardia-feedback-url";

const std::set<std::string_view>& InstanceKeys() {
  static const base::NoDestructor<std::set<std::string_view>> keys({
      "jsLocation",   "chromiumSwitches", "downloadsDir",    "updateFeed",
      "allowAudio",   "allowOcclusion",   "releaseNotes",    "cliHome",
      "cliBinDir",    "cliUrl",           "syncFolder",      "sharedFolders",
      "importSourceDir", "importSafariHome",
  });
  return *keys;
}

const std::set<std::string_view>& TestOnlyInstanceKeys() {
  static const base::NoDestructor<std::set<std::string_view>> keys(
      {"updateFeed", "importSourceDir", "importSafariHome"});
  return *keys;
}

const std::set<std::string_view>& TestKeys() {
  static const base::NoDestructor<std::set<std::string_view>> keys({
      "keychain",          "keychainHiddenReads",  "keychainFail",
      "safeStorageAnswer", "reauth",               "bluetoothChooser",
      "externalProtocolNoLaunch", "externalProtocolApp",
      "mediaRouteProvider", "systemMediaPermission", "applyProfileGate",
      "contextMenu",       "loginsDelay",          "loginsReleaseAfter",
      "cdpTabsVisible",    "pipSelfTest",          "pipHover",
      "fakeFullScreenMs",  "shadersKeyWindow",     "peekStrict",
      "importSecret",      "importDiaBundleId",    "importDiaWindows",
      "cliInstallScript",  "legacySource",         "legacyCrashAfter",
      "bangsUrl",          "onboarding",           "whatsNew",
      "telemetry",         "liveMock",             "calendarFixture",
      "appMenu",           "appDialog",            "loginsTimeout",
      "externalAppLaunch", "nativeDragRefused",    "passwordHelper",
      "desktopTools",
  });
  return *keys;
}

const std::set<std::string_view>& KeysWhoseValuesHoldCommas() {
  static const base::NoDestructor<std::set<std::string_view>> keys({
      "chromiumSwitches", "downloadsDir",     "updateFeed",
      "cliHome",          "cliBinDir",        "cliUrl",
      "syncFolder",       "sharedFolders",    "importSourceDir",
      "importSafariHome", "importSecret",     "cliInstallScript",
      "legacySource",     "bangsUrl",         "liveMock",
      "passwordHelper",
  });
  return *keys;
}

const std::set<std::string_view>& TraceAreas() {
  static const base::NoDestructor<std::set<std::string_view>> areas(
      {"visibility", "pip", "pipZoom", "trafficLights", "profileGate", "keys",
       "menus"});
  return *areas;
}

std::string_view Trimmed(std::string_view text) {
  return base::TrimWhitespaceASCII(text, base::TRIM_ALL);
}

std::string_view HeadOf(std::string_view piece) {
  return Trimmed(piece.substr(0, piece.find('=')));
}

}

base::DictValue LaunchConfig::ToValue() const {
  base::DictValue value;
  if (data_directory.empty()) {
    value.Set("dataDirectory", base::Value());
  } else {
    value.Set("dataDirectory", data_directory.value());
  }
  value.Set("configDirectory", config_directory.value());
  value.Set("background", background);
  value.Set("isolated", !data_directory.empty());
  value.Set("testInstance", test_instance);
  base::DictValue instance_value;
  for (const auto& [key, entry] : instance) {
    instance_value.Set(key, entry);
  }
  value.Set("instance", std::move(instance_value));
  base::DictValue switches_value;
  for (const auto& [name, on] : switches) {
    switches_value.Set(name, on);
  }
  value.Set("switches", std::move(switches_value));
  base::ListValue trace_value;
  for (const std::string& area : trace) {
    trace_value.Append(area);
  }
  value.Set("trace", std::move(trace_value));
  base::DictValue test_value;
  for (const auto& [key, entry] : test) {
    test_value.Set(key, entry);
  }
  value.Set("test", std::move(test_value));
  if (feedback_url.empty()) {
    value.Set("feedbackURL", base::Value());
  } else {
    value.Set("feedbackURL", feedback_url);
  }
  return value;
}

bool LaunchConfig::TestFlag(std::string_view key) const {
  auto found = test.find(key);
  return found != test.end() && Truthy(found->second);
}

std::string LaunchConfig::TestValue(std::string_view key) const {
  auto found = test.find(key);
  return found == test.end() ? std::string() : found->second;
}

bool LaunchConfig::InstanceFlag(std::string_view key) const {
  auto found = instance.find(key);
  return found != instance.end() && Truthy(found->second);
}

bool Truthy(std::string_view value) {
  return !value.empty() && value != "0" && value != "off" && value != "false";
}

KeyedEntries ParseInstanceEntries(std::string_view text,
                                  std::vector<std::string>* unknown) {
  return ParseKeyedEntries(text, InstanceKeys(), KeysWhoseValuesHoldCommas(),
                           unknown);
}

KeyedEntries ParseKeyedEntries(std::string_view text,
                               const std::set<std::string_view>& known,
                               const std::set<std::string_view>& holding_commas,
                               std::vector<std::string>* unknown) {
  KeyedEntries entries;
  if (text.empty()) {
    return entries;
  }
  std::vector<std::string> pieces;
  std::string previous_key;
  for (std::string_view piece : base::SplitStringPiece(
           text, ",", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
    const std::string_view head = HeadOf(piece);
    if (!pieces.empty() && !known.contains(head) &&
        holding_commas.contains(previous_key)) {
      pieces.back().append(",").append(piece);
      continue;
    }
    pieces.emplace_back(piece);
    previous_key = std::string(head);
  }
  for (const std::string& piece : pieces) {
    const size_t equals = piece.find('=');
    const std::string key(Trimmed(std::string_view(piece).substr(0, equals)));
    if (key.empty()) {
      continue;
    }
    if (!known.contains(key)) {
      if (unknown) {
        unknown->push_back(key);
      }
      continue;
    }
    entries[key] = equals == std::string::npos
                       ? std::string("1")
                       : std::string(Trimmed(
                             std::string_view(piece).substr(equals + 1)));
  }
  return entries;
}

std::map<std::string, bool, std::less<>> ParseSwitchEntries(
    std::string_view text) {
  std::map<std::string, bool, std::less<>> entries;
  for (std::string_view piece : base::SplitStringPiece(
           text, ",", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
    std::vector<std::string_view> parts = base::SplitStringPiece(
        piece, "=", base::TRIM_WHITESPACE, base::SPLIT_WANT_ALL);
    if (parts.size() != 2 || parts[0].empty()) {
      continue;
    }
    if (parts[1] == "on" || parts[1] == "1" || parts[1] == "true") {
      entries[std::string(parts[0])] = true;
    } else if (parts[1] == "off" || parts[1] == "0" || parts[1] == "false") {
      entries[std::string(parts[0])] = false;
    }
  }
  return entries;
}

LaunchConfig ReadLaunchConfig(const base::CommandLine& command_line,
                              const base::FilePath& xdg_config_home) {
  LaunchConfig config;
  config.data_directory =
      command_line.GetSwitchValuePath(ardiacore::kDataDirSwitch);
  config.config_directory = config.data_directory.empty()
                                ? xdg_config_home.Append("ardia")
                                : config.data_directory.Append("config");
  config.background = command_line.HasSwitch(ardiacore::kBackgroundSwitch);
  config.test_instance = command_line.HasSwitch(kTestInstanceSwitch);
  for (std::string_view key : InstanceKeys()) {
    const std::string name = "ardia-" + base::ToLowerASCII(key);
    if (command_line.HasSwitch(name)) {
      config.instance[std::string(key)] =
          command_line.GetSwitchValueASCII(name);
    }
  }
  config.switches = ParseSwitchEntries(
      command_line.GetSwitchValueASCII(ardiacore::kSwitchesSwitch));
  config.feedback_url = command_line.GetSwitchValueASCII(kFeedbackUrlSwitchName);
  if (!config.test_instance) {
    for (std::string_view key : TestOnlyInstanceKeys()) {
      config.instance.erase(std::string(key));
    }
    return config;
  }
  for (std::string_view area : base::SplitStringPiece(
           command_line.GetSwitchValueASCII(ardiacore::kTraceSwitch), ",",
           base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (TraceAreas().contains(area) &&
        !std::ranges::contains(config.trace, area)) {
      config.trace.emplace_back(area);
    }
  }
  config.test = ParseKeyedEntries(
      command_line.GetSwitchValueASCII(ardiacore::kTestSwitch), TestKeys(),
      KeysWhoseValuesHoldCommas(), nullptr);
  return config;
}

const LaunchConfig& CurrentLaunchConfig() {
  static const base::NoDestructor<LaunchConfig> config([] {
    std::unique_ptr<base::Environment> env = base::Environment::Create();
    return ReadLaunchConfig(
        *base::CommandLine::ForCurrentProcess(),
        base::nix::GetXDGDirectory(env.get(), base::nix::kXdgConfigHomeEnvVar,
                                   base::nix::kDotConfigDir));
  }());
  return *config;
}

}
