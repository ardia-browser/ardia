#ifndef ARDIA_MAC_AC_MAC_SHARED_FOLDERS_H_
#define ARDIA_MAC_AC_MAC_SHARED_FOLDERS_H_

#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "ardia/mac/ac_mac_shell_host.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

namespace ardia_mac::shared_folders {

bool Handles(std::string_view method);
void AppendCapabilities(base::ListValue& capabilities);
base::DictValue Location();
void Invoke(ShellHostView& host,
            const std::string& method,
            const base::ListValue* values,
            ShellHostView::Done done);

class Watcher {
 public:
  using OnChange = base::RepeatingCallback<void(std::vector<std::string>)>;

  explicit Watcher(OnChange on_change);
  Watcher(const Watcher&) = delete;
  Watcher& operator=(const Watcher&) = delete;
  ~Watcher();

  void Watch(std::vector<std::string> paths);

 private:
  struct Core;

  void Deliver(std::vector<std::string> paths);

  std::unique_ptr<Core> core_;
  OnChange on_change_;
  base::WeakPtrFactory<Watcher> weak_factory_{this};
};

}

#endif
