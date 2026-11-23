#include "ardia/linux/ac_linux_desktop_platform.h"

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "ardia/desktop/ac_desktop_platform.h"
#include "ardia/linux/ac_linux_calendar_service.h"
#include "ardia/linux/ac_linux_desktop_core.h"
#include "ardia/linux/ac_linux_geoclue.h"
#include "ardia/linux/ac_linux_password_prompt.h"
#include "ardia/linux/ac_linux_power.h"
#include "ardia/linux/ac_linux_self_update.h"
#include "ardia/linux/ac_linux_sync_keystore.h"
#include "ardia/linux/ac_linux_system.h"
#include "ardia/linux/ac_linux_window_caption.h"

namespace ardia::linux_desktop_platform {

namespace {

using desktop::PlatformCall;
using desktop::PlatformCapability;
using desktop::PlatformReply;
using desktop::SecretStatus;

SecretStatus StatusOf(linux_sync::KeyStatus status) {
  switch (status) {
    case linux_sync::KeyStatus::kOk:
      return SecretStatus::kOk;
    case linux_sync::KeyStatus::kNotFound:
      return SecretStatus::kNotFound;
    case linux_sync::KeyStatus::kLocked:
      return SecretStatus::kLocked;
    case linux_sync::KeyStatus::kUnavailable:
      return SecretStatus::kUnavailable;
  }
  return SecretStatus::kUnavailable;
}

class LinuxSecretStore final : public desktop::SecretStore {
 public:
  explicit LinuxSecretStore(std::unique_ptr<linux_sync::KeyStore> store) : store_(std::move(store)) {}

  std::string_view kind() const override { return store_->kind(); }
  SecretStatus Load(std::string_view account, std::vector<uint8_t>* secret) override {
    return StatusOf(store_->Load(account, secret));
  }
  SecretStatus Save(std::string_view account, const std::vector<uint8_t>& secret) override {
    return StatusOf(store_->Save(account, secret));
  }
  SecretStatus Delete(std::string_view account) override { return StatusOf(store_->Delete(account)); }
  SecretStatus Probe() override { return StatusOf(store_->Probe()); }

 private:
  std::unique_ptr<linux_sync::KeyStore> store_;
};

bool Lists(const auto& methods, std::string_view method) {
  return std::ranges::any_of(methods, [method](std::string_view listed) { return method == listed; });
}

class LinuxDesktopPlatform final : public desktop::DesktopPlatform {
 public:
  std::optional<PlatformCapability> CapabilityFor(std::string_view method) const override {
    return CapabilityForMethod(method);
  }

  void Invoke(PlatformCapability capability, const PlatformCall& call, PlatformReply done) override {
    switch (capability) {
      case PlatformCapability::kDefaultBrowser:
      case PlatformCapability::kLoginItem:
      case PlatformCapability::kOpenExternal:
        return ardiacore::LinuxSystemInvoke(call.method, call.args, std::move(done));
      case PlatformCapability::kCalendar:
        return LinuxCalendarInvoke(call.documents, std::string(call.method), call.args, std::move(done));
      case PlatformCapability::kSelfUpdate:
        return linux_self_update::Invoke(call.method, call.args, std::move(done));
      case PlatformCapability::kSecrets:
      case PlatformCapability::kReauth:
      case PlatformCapability::kLocation:
      case PlatformCapability::kPower:
      case PlatformCapability::kWindowDecorations:
        break;
    }
    std::move(done).Run(false, base::Value(base::DictValue()
        .Set("code", "ERR_UNAVAILABLE")
        .Set("message", "This call isn't available on Linux")));
  }

  std::unique_ptr<desktop::SecretStore> OpenSecretStore(const base::FilePath& file_store_directory) override {
    auto store = file_store_directory.empty() ? linux_sync::MakeSecretServiceKeyStore()
                                             : linux_sync::MakeFileKeyStore(file_store_directory.value());
    return store ? std::make_unique<LinuxSecretStore>(std::move(store)) : nullptr;
  }

  void InstallReauth() override { linux_password::InstallReauthFallback(); }

  void InstallLocationProvider() override { InstallLinuxLocationProvider(); }

  void CurrentPower(base::OnceCallback<void(base::DictValue)> done) override {
    ardiacore::LinuxPowerMonitor::Get().Current(std::move(done));
  }

  base::CallbackListSubscription WatchPower(PowerListener listener) override {
    return ardiacore::LinuxPowerMonitor::Get().Subscribe(std::move(listener));
  }

  bool StartWindowMove(views::Widget* widget) override { return linux_window::StartCaptionMove(widget); }

  bool CaptionDoubleClick(views::Widget* widget) override { return linux_window::CaptionDoubleClick(widget); }
};

}

std::optional<desktop::PlatformCapability> CapabilityForMethod(std::string_view method) {
  if (Lists(kDefaultBrowserCalls, method)) return PlatformCapability::kDefaultBrowser;
  if (Lists(kLoginItemCalls, method)) return PlatformCapability::kLoginItem;
  if (Lists(kOpenExternalCalls, method)) return PlatformCapability::kOpenExternal;
  if (LinuxCalendarInvokes(method)) return PlatformCapability::kCalendar;
  if (linux_self_update::Invokes(method)) return PlatformCapability::kSelfUpdate;
  return std::nullopt;
}

}

namespace ardia::desktop {

std::unique_ptr<DesktopPlatform> CreateDesktopPlatform() {
  return std::make_unique<linux_desktop_platform::LinuxDesktopPlatform>();
}

}
