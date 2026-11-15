// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_LAUNCH_CONFIG_H_
#define ARDIA_LINUX_MODULES_LAUNCH_CONFIG_H_

#include <map>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"

namespace base {
class CommandLine;
}

namespace ardia_linux {

using KeyedEntries = std::map<std::string, std::string, std::less<>>;

struct LaunchConfig {
  base::FilePath data_directory;
  base::FilePath config_directory;
  bool background = false;
  bool test_instance = false;
  KeyedEntries instance;
  std::map<std::string, bool, std::less<>> switches;
  std::vector<std::string> trace;
  KeyedEntries test;
  std::string feedback_url;

  base::DictValue ToValue() const;
  bool TestFlag(std::string_view key) const;
  std::string TestValue(std::string_view key) const;
  bool InstanceFlag(std::string_view key) const;
};

bool Truthy(std::string_view value);

KeyedEntries ParseKeyedEntries(std::string_view text,
                               const std::set<std::string_view>& known,
                               const std::set<std::string_view>& holding_commas,
                               std::vector<std::string>* unknown);

std::string InstanceSwitchName(std::string_view key);

KeyedEntries ParseInstanceEntries(std::string_view text,
                                  std::vector<std::string>* unknown);

std::map<std::string, bool, std::less<>> ParseSwitchEntries(
    std::string_view text);

LaunchConfig ReadLaunchConfig(const base::CommandLine& command_line,
                              const base::FilePath& xdg_config_home);

const LaunchConfig& CurrentLaunchConfig();

}

#endif
