#include "ardia/linux/ui_host/linux_engine_module.h"

#include <memory>
#include <string>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/windows/app_window.h"
#include "base/functional/bind.h"
#include "base/strings/strcat.h"
#include "base/version.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/component_updater/widevine_cdm_component_installer.h"
#include "components/component_updater/component_updater_service.h"
#include "components/prefs/pref_service.h"
#include "components/update_client/crx_update_item.h"
#include "components/update_client/update_client.h"

namespace ardia_linux {

namespace {

constexpr char kWidevineComponentId[] = "oimompecagnajdejgnnjijobebaeigek";
constexpr char kProtectedContentEvent[] = "onProtectedContent";

PrefService* LocalState() {
  return g_browser_process ? g_browser_process->local_state() : nullptr;
}

bool ProtectedContentOn() {
  PrefService* local_state = LocalState();
  return local_state &&
         local_state->GetBoolean(
             component_updater::kArdiaPlayProtectedContentPref);
}

component_updater::ComponentUpdateService* Components() {
  return g_browser_process ? g_browser_process->component_updater() : nullptr;
}

base::Version InstalledWidevine() {
  if (component_updater::ComponentUpdateService* components = Components()) {
    for (const component_updater::ComponentInfo& info :
         components->GetComponents()) {
      if (info.id == kWidevineComponentId && info.version.IsValid() &&
          info.version.CompareTo(base::Version("0.0.0.0")) > 0) {
        return info.version;
      }
    }
  }
  return base::Version();
}

class ProtectedContent : public component_updater::ServiceObserver {
 public:
  ProtectedContent()
      : on_at_launch_(ProtectedContentOn()),
        installed_at_launch_(InstalledWidevine().IsValid()) {
    component_ = installed_at_launch_ ? ProtectedContentComponent::kInstalled
                                      : ProtectedContentComponent::kAbsent;
    CountLinux(on_at_launch_ ? "linux_protected_content_on_at_launch"
                             : "linux_protected_content_off_at_launch");
    if (component_updater::ComponentUpdateService* components = Components()) {
      components->AddObserver(this);
    }
  }

  ~ProtectedContent() override {
    if (component_updater::ComponentUpdateService* components = Components()) {
      components->RemoveObserver(this);
    }
  }

  base::DictValue State() const {
    const bool on = ProtectedContentOn();
    const base::Version version = InstalledWidevine();
    base::DictValue state;
    state.Set("enabled", on);
    state.Set("component", ProtectedContentComponentName(component_));
    state.Set("version", version.IsValid() ? base::Value(version.GetString())
                                           : base::Value());
    state.Set("playsNow", on && on_at_launch_ && installed_at_launch_);
    state.Set("restartNeeded",
              on ? !(on_at_launch_ && installed_at_launch_) && version.IsValid()
                 : on_at_launch_ && installed_at_launch_);
    return state;
  }

  void SetEnabled(bool on) {
    PrefService* local_state = LocalState();
    if (!local_state) {
      return;
    }
    if (ProtectedContentOn() != on) {
      CountLinux(on ? "linux_protected_content_turned_on"
                    : "linux_protected_content_turned_off");
      Note("drm", on ? "play protected content turned on"
                     : "play protected content turned off");
    }
    local_state->SetBoolean(component_updater::kArdiaPlayProtectedContentPref,
                            on);
    if (on && component_ != ProtectedContentComponent::kInstalled) {
      component_ = ProtectedContentComponent::kChecking;
    }
    Changed();
  }

  void OnEvent(const update_client::CrxUpdateItem& item) override {
    if (item.id != kWidevineComponentId) {
      return;
    }
    using update_client::ComponentState;
    const ProtectedContentComponent before = component_;
    switch (item.state) {
      case ComponentState::kChecking:
      case ComponentState::kCanUpdate:
        if (component_ != ProtectedContentComponent::kInstalled) {
          component_ = ProtectedContentComponent::kChecking;
        }
        break;
      case ComponentState::kDownloading:
      case ComponentState::kDecompressing:
      case ComponentState::kPatching:
      case ComponentState::kUpdating:
        component_ = ProtectedContentComponent::kDownloading;
        break;
      case ComponentState::kUpdated:
        component_ = ProtectedContentComponent::kInstalled;
        CountLinux("linux_protected_content_installed");
        Note("drm", "the Widevine component installed");
        break;
      case ComponentState::kUpToDate:
        component_ = InstalledWidevine().IsValid()
                         ? ProtectedContentComponent::kInstalled
                         : ProtectedContentComponent::kAbsent;
        CountLinux("linux_protected_content_up_to_date");
        break;
      case ComponentState::kUpdateError:
        component_ = ProtectedContentComponent::kFailed;
        CountLinux("linux_protected_content_failed");
        Note("drm", "the Widevine component failed to install");
        break;
      default:
        break;
    }
    if (component_ != before) {
      Changed();
    }
  }

 private:
  void Changed() {
    if (ModuleRegistry::Exists()) {
      ModuleRegistry::Get().Emit(kLinuxEngineModule, kProtectedContentEvent,
                                 base::Value(State()));
    }
  }

  const bool on_at_launch_;
  const bool installed_at_launch_;
  ProtectedContentComponent component_;
};

ProtectedContent*& Current() {
  static ProtectedContent* current = nullptr;
  return current;
}

ProtectedContent& Protected() {
  if (!Current()) {
    Current() = new ProtectedContent();
  }
  return *Current();
}

}

std::string_view ProtectedContentComponentName(
    ProtectedContentComponent state) {
  switch (state) {
    case ProtectedContentComponent::kAbsent:
      return "absent";
    case ProtectedContentComponent::kChecking:
      return "checking";
    case ProtectedContentComponent::kDownloading:
      return "downloading";
    case ProtectedContentComponent::kInstalled:
      return "installed";
    case ProtectedContentComponent::kFailed:
      return "failed";
  }
  return "absent";
}

void RegisterLinuxEngineModule(ModuleRegistry& registry) {
  Protected();
  registry.Define(kLinuxEngineModule)
      .Constant("pagesUnderUi", base::Value(AppWindowView::PagesUnderUi()))
      .Sync("protectedContent",
            base::BindRepeating([](const base::ListValue&) {
              return ModuleResult(base::Value(Protected().State()));
            }))
      .Async("setProtectedContent",
             base::BindRepeating([](base::ListValue args, ModuleReply reply) {
               if (args.empty() || !args.front().is_bool()) {
                 std::move(reply).Run(ModuleFailure(
                     "setProtectedContent(on) takes a boolean", "ERR_ARGS"));
                 return;
               }
               Protected().SetEnabled(args.front().GetBool());
               std::move(reply).Run(base::Value(Protected().State()));
             }));
}

void StopLinuxEngineModule() {
  delete std::exchange(Current(), nullptr);
}

}
