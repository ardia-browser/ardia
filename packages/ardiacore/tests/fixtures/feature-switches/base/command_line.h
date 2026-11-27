#pragma once

#include <map>
#include <string>
#include <string_view>

namespace base {

class CommandLine {
 public:
  std::string GetSwitchValueASCII(std::string_view name) const {
    auto found = switches_.find(std::string(name));
    return found == switches_.end() ? std::string() : found->second;
  }
  bool HasSwitch(std::string_view name) const { return switches_.contains(std::string(name)); }
  void RemoveSwitch(std::string_view name) { switches_.erase(std::string(name)); }
  void AppendSwitchASCII(std::string_view name, std::string_view value) {
    switches_[std::string(name)] = std::string(value);
  }

 private:
  std::map<std::string, std::string> switches_;
};

}
