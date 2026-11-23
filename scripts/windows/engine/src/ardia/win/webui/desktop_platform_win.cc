#include <windows.h>

#include <memory>
#include <optional>
#include <string_view>
#include <utility>

#include "ardia/desktop/ac_desktop_platform.h"
#include "base/values.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/views/widget/widget.h"

namespace ardia_win {

namespace {

using ardia::desktop::PlatformCall;
using ardia::desktop::PlatformCapability;
using ardia::desktop::PlatformReply;

HWND WidgetWindow(views::Widget* widget) {
  if (!widget || !widget->GetNativeWindow() || !widget->GetNativeWindow()->GetHost()) {
    return nullptr;
  }
  return widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget();
}

class WinDesktopPlatform final : public ardia::desktop::DesktopPlatform {
 public:
  std::optional<PlatformCapability> CapabilityFor(std::string_view method) const override { return std::nullopt; }

  void Invoke(PlatformCapability capability, const PlatformCall& call, PlatformReply done) override {
    std::move(done).Run(false, base::Value(base::DictValue()
        .Set("code", "ERR_UNAVAILABLE")
        .Set("message", "This call isn't available on Windows yet")));
  }

  std::unique_ptr<ardia::desktop::SecretStore> OpenSecretStore(const base::FilePath& file_store_directory) override {
    return nullptr;
  }

  void InstallReauth() override {}

  void InstallLocationProvider() override {}

  void CurrentPower(base::OnceCallback<void(base::DictValue)> done) override { std::move(done).Run(base::DictValue()); }

  base::CallbackListSubscription WatchPower(PowerListener listener) override { return {}; }

  bool StartWindowMove(views::Widget* widget) override {
    const HWND window = WidgetWindow(widget);
    if (!window || (GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0) {
      return false;
    }
    ReleaseCapture();
    PostMessageW(window, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
    return true;
  }

  bool CaptionDoubleClick(views::Widget* widget) override {
    if (!widget) {
      return false;
    }
    if (widget->IsMaximized()) {
      widget->Restore();
    } else {
      widget->Maximize();
    }
    return true;
  }
};

}

}

namespace ardia::desktop {

std::unique_ptr<DesktopPlatform> CreateDesktopPlatform() {
  return std::make_unique<ardia_win::WinDesktopPlatform>();
}

}
