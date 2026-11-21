// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_INPUT_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_INPUT_H_

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace ardia {

inline constexpr int kCdpAlt = 1;
inline constexpr int kCdpCtrl = 2;
inline constexpr int kCdpMeta = 4;
inline constexpr int kCdpShift = 8;

struct PluginKeyEvent {
  std::optional<std::string> type;
  std::optional<int> windows_key_code;
  bool has_native_key_code = false;
  bool has_system_key = false;
  std::optional<int> modifiers;
  std::optional<std::string> key;
  std::optional<std::string> code;
  bool commands_valid = true;
  std::vector<std::string> commands;
};

std::string PluginKeyRefusal(const PluginKeyEvent& event);

struct PluginParam {
  enum class Kind { kInt, kDouble, kString, kOther };
  Kind kind = Kind::kOther;
  long long int_value = 0;
  double double_value = 0;
  std::string string_value;
};

using PluginParams = std::map<std::string, PluginParam>;

struct PluginMouseParams {
  std::string type;
  double x = 0;
  double y = 0;
  int modifiers = 0;
  std::optional<double> delta_x;
  std::optional<double> delta_y;
};

struct PluginClickParams {
  double x = 0;
  double y = 0;
  std::string button = "left";
  int click_count = 1;
  int modifiers = 0;
};

std::string PluginMouseRefusal(const PluginParams& params,
                               PluginMouseParams* out);

std::string PluginClickRefusal(const PluginParams& params,
                               PluginClickParams* out);

}

#endif
