#ifndef ARDIA_DESKTOP_AC_DESKTOP_PLATFORM_H_
#define ARDIA_DESKTOP_AC_DESKTOP_PLATFORM_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/callback_list.h"
#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/values.h"

namespace views {
class Widget;
}

namespace ardia::desktop {

enum class PlatformCapability {
  kSecrets,
  kReauth,
  kDefaultBrowser,
  kLoginItem,
  kCalendar,
  kLocation,
  kPower,
  kOpenExternal,
  kSelfUpdate,
  kWindowDecorations,
};

inline constexpr PlatformCapability kPlatformCapabilities[] = {
    PlatformCapability::kSecrets,      PlatformCapability::kReauth,       PlatformCapability::kDefaultBrowser,
    PlatformCapability::kLoginItem,    PlatformCapability::kCalendar,     PlatformCapability::kLocation,
    PlatformCapability::kPower,        PlatformCapability::kOpenExternal, PlatformCapability::kSelfUpdate,
    PlatformCapability::kWindowDecorations,
};

inline constexpr std::string_view PlatformCapabilityName(PlatformCapability capability) {
  switch (capability) {
    case PlatformCapability::kSecrets:
      return "secrets";
    case PlatformCapability::kReauth:
      return "reauth";
    case PlatformCapability::kDefaultBrowser:
      return "defaultBrowser";
    case PlatformCapability::kLoginItem:
      return "loginItem";
    case PlatformCapability::kCalendar:
      return "calendar";
    case PlatformCapability::kLocation:
      return "location";
    case PlatformCapability::kPower:
      return "power";
    case PlatformCapability::kOpenExternal:
      return "openExternal";
    case PlatformCapability::kSelfUpdate:
      return "selfUpdate";
    case PlatformCapability::kWindowDecorations:
      return "windowDecorations";
  }
  return "";
}

using PlatformReply = base::OnceCallback<void(bool, base::Value)>;

struct PlatformCall {
  std::string_view method;
  const base::ListValue& args;
  base::FilePath documents;
};

enum class SecretStatus { kOk, kNotFound, kLocked, kUnavailable };

class SecretStore {
 public:
  virtual ~SecretStore() = default;
  virtual std::string_view kind() const = 0;
  virtual SecretStatus Load(std::string_view account, std::vector<uint8_t>* secret) = 0;
  virtual SecretStatus Save(std::string_view account, const std::vector<uint8_t>& secret) = 0;
  virtual SecretStatus Delete(std::string_view account) = 0;
  virtual SecretStatus Probe() = 0;
};

class DesktopPlatform {
 public:
  using PowerListener = base::RepeatingCallback<void(const base::DictValue&)>;

  virtual ~DesktopPlatform() = default;

  virtual std::optional<PlatformCapability> CapabilityFor(std::string_view method) const = 0;
  virtual void Invoke(PlatformCapability capability, const PlatformCall& call, PlatformReply done) = 0;

  virtual std::unique_ptr<SecretStore> OpenSecretStore(const base::FilePath& file_store_directory) = 0;
  virtual void InstallReauth() = 0;
  virtual void InstallLocationProvider() = 0;

  virtual void CurrentPower(base::OnceCallback<void(base::DictValue)> done) = 0;
  virtual base::CallbackListSubscription WatchPower(PowerListener listener) = 0;

  virtual bool StartWindowMove(views::Widget* widget) = 0;
  virtual bool CaptionDoubleClick(views::Widget* widget) = 0;
};

std::unique_ptr<DesktopPlatform> CreateDesktopPlatform();

DesktopPlatform& Platform();

}

#endif
