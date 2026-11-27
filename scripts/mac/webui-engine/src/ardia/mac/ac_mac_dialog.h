#ifndef ARDIA_MAC_AC_MAC_DIALOG_H_
#define ARDIA_MAC_AC_MAC_DIALOG_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "ardia/mac/ac_mac_dialog_policy.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

namespace views {
class Widget;
}

namespace ardia_mac {

class DialogSheets {
 public:
  using Resolved = base::RepeatingCallback<void(base::Value envelope)>;

  DialogSheets(views::Widget* parent, std::string window_id, bool background, Resolved resolved);
  DialogSheets(const DialogSheets&) = delete;
  DialogSheets& operator=(const DialogSheets&) = delete;
  ~DialogSheets();

  dialog_policy::Refusal Begin(const base::DictValue& request, const std::string& generation,
                               const std::string& live_generation);
  bool Cancel(const std::string& dialog_id);
  void CancelAll();
  std::uint64_t Suspend();
  bool Resume(std::uint64_t token);
  std::size_t pending() const { return queue_.size(); }

 private:
  struct Sheet;

  void Pump();
  void Complete(std::string dialog_id, std::uint64_t sequence, dialog_policy::Response response);
  void Present(const dialog_policy::Queue::Entry& entry);
  void Dismiss();

  base::WeakPtr<views::Widget> parent_;
  std::string window_id_;
  bool background_;
  Resolved resolved_;
  dialog_policy::Queue queue_;
  std::unique_ptr<Sheet> sheet_;
  bool pumping_ = false;
  bool cancelling_ = false;
  base::WeakPtrFactory<DialogSheets> weak_factory_{this};
};

}

#endif
