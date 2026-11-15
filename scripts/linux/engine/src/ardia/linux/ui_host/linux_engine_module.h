#ifndef ARDIA_LINUX_UI_HOST_LINUX_ENGINE_MODULE_H_
#define ARDIA_LINUX_UI_HOST_LINUX_ENGINE_MODULE_H_

#include <string_view>

namespace ardia_linux {

class ModuleRegistry;

inline constexpr char kLinuxEngineModule[] = "ArdiaLinuxEngine";

enum class ProtectedContentComponent {
  kAbsent,
  kChecking,
  kDownloading,
  kInstalled,
  kFailed,
};

std::string_view ProtectedContentComponentName(ProtectedContentComponent state);

void RegisterLinuxEngineModule(ModuleRegistry& registry);

void StopLinuxEngineModule();

}

#endif
