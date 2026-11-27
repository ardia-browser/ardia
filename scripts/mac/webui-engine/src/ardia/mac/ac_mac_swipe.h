#ifndef ARDIA_MAC_AC_MAC_SWIPE_H_
#define ARDIA_MAC_AC_MAC_SWIPE_H_

#include <memory>
#include <string>

#include "base/functional/callback.h"
#include "base/values.h"

namespace views {
class Widget;
}

namespace ardia_mac {

class ShellHostView;

class ScrollGestures {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  ScrollGestures(ShellHostView* host, views::Widget* widget);
  ScrollGestures(const ScrollGestures&) = delete;
  ScrollGestures& operator=(const ScrollGestures&) = delete;
  ~ScrollGestures();

  static void AppendCapabilities(base::ListValue& capabilities);
  static bool Handles(const std::string& method);
  void Invoke(const std::string& method, const base::DictValue& args, Done done);
  void Revalidate();

  struct Native;

 private:
  std::unique_ptr<Native> state_;
};

}

#endif
