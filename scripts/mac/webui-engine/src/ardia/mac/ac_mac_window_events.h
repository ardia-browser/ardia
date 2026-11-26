#ifndef ARDIA_MAC_AC_MAC_WINDOW_EVENTS_H_
#define ARDIA_MAC_AC_MAC_WINDOW_EVENTS_H_

#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "ardia/mac/ac_mac_window_policy.h"
#include "base/functional/callback.h"

namespace views {
class Widget;
}

namespace ardia_mac {

class WindowEvents {
 public:
  enum class Kind { kFocus, kBlur, kFrame, kFullScreen, kMiniaturize, kDeminiaturize, kClose, kCloseButton };
  struct Pointer {
    double x = 0;
    double y = 0;
    double width = 0;
    double height = 0;
    bool pressed = false;
    bool covered = false;
  };
  using Changed = base::RepeatingCallback<void(Kind)>;
  using Moved = base::RepeatingCallback<void(const Pointer&)>;

  WindowEvents(views::Widget* widget, Changed changed, Moved moved);
  WindowEvents(const WindowEvents&) = delete;
  WindowEvents& operator=(const WindowEvents&) = delete;
  ~WindowEvents();

  void WatchPointer(bool on);
  void PollPointer(bool on);
  std::optional<Pointer> LivePointer() const;
  void RouteCloseButton();

  bool Focused() const;
  window_policy::WindowState State() const;
  std::vector<window_policy::Frame> Screens() const;

  bool ToggleFullScreen();
  bool FullScreen() const;
  void EnterFullScreen();
  void Minimize();
  void ToggleZoom();
  void SetTitle(const std::string& title);
  void PerformClose();

 private:
  struct Native;
  std::unique_ptr<Native> state_;
};

void SetAppAppearance(window_policy::Appearance appearance);
bool AppIsDark();

}

#endif
