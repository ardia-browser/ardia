#ifndef ARDIA_MAC_AC_MAC_POPOVER_H_
#define ARDIA_MAC_AC_MAC_POPOVER_H_

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "ardia/mac/ac_mac_popover_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "ui/gfx/native_ui_types.h"

class Profile;

namespace content {
class WebContents;
}

namespace views {
class Widget;
}

namespace ardia_mac {

class PopoverHost {
 public:
  using Dismissed =
      base::RepeatingCallback<void(const std::string& key, std::string_view reason)>;
  using Sink = base::RepeatingCallback<void(std::string_view event, const base::Value& payload)>;

  PopoverHost(views::Widget* parent,
              Profile* profile,
              std::string window_id,
              bool background_instance,
              Dismissed dismissed);
  PopoverHost(const PopoverHost&) = delete;
  PopoverHost& operator=(const PopoverHost&) = delete;
  ~PopoverHost();

  std::optional<std::string> Open(const base::DictValue& args,
                                  gfx::NativeView shell_view,
                                  double shell_zoom);
  std::optional<std::string> Update(const base::DictValue& args,
                                    gfx::NativeView shell_view,
                                    double shell_zoom);
  std::optional<std::string> Close(const base::DictValue& args);
  void CloseAll(popover::Event event);

  bool Owns(const content::WebContents* contents) const;
  std::optional<std::string> BootstrapJson(const content::WebContents* contents) const;
  std::optional<std::string> IdFor(const content::WebContents* contents) const;
  std::optional<base::Value> PropsFor(const content::WebContents* contents) const;
  void Connect(const content::WebContents* contents, Sink sink);
  void Dismiss(const std::string& key, popover::Event event);
  std::size_t open_count() const { return panels_.size(); }

  struct Panel;

 private:
  std::optional<std::string> Place(Panel& panel,
                                   const base::DictValue& args,
                                   gfx::NativeView shell_view,
                                   double shell_zoom);
  void Show(Panel& panel);

  raw_ptr<views::Widget> parent_;
  raw_ptr<Profile> profile_;
  std::string window_id_;
  bool background_;
  Dismissed dismissed_;
  std::map<std::string, std::unique_ptr<Panel>> panels_;
  base::WeakPtrFactory<PopoverHost> weak_factory_{this};
};

}

#endif
