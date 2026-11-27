#include <iostream>
#include <optional>
#include <sstream>
#include <string>

#include "ardia/linux/ac_linux_self_update_policy.h"

namespace policy = ardia::linux_self_update_policy;

namespace {

std::string FromHex(const std::string& text) {
  std::string out;
  if (text == "-") return out;
  for (size_t i = 0; i + 1 < text.size(); i += 2) out.push_back(static_cast<char>(std::stoi(text.substr(i, 2), nullptr, 16)));
  return out;
}

std::string Run(const std::string& line) {
  std::istringstream in(line);
  std::string command, first, second, third;
  in >> command >> first >> second >> third;
  if (command == "parse") {
    const std::optional<policy::Kind> kind = policy::InstallableKind(third);
    if (!kind) return "usage";
    const policy::ManifestRead read = policy::PackageInManifest(FromHex(first), FromHex(second), *kind);
    if (!read.package) return "error " + std::string(read.reason);
    return "ok " + read.package->name + " " + std::to_string(read.package->size);
  }
  if (command == "valid") return policy::ValidVersion(FromHex(first)) ? "1" : "0";
  if (command == "compare") {
    const std::optional<int> order = policy::CompareVersions(FromHex(first), FromHex(second));
    return order ? std::to_string(*order) : "none";
  }
  return "usage";
}

}

int main() {
  for (std::string line; std::getline(std::cin, line);) std::cout << Run(line) << "\n";
  return 0;
}
