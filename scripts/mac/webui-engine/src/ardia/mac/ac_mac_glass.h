#ifndef ARDIA_MAC_AC_MAC_GLASS_H_
#define ARDIA_MAC_AC_MAC_GLASS_H_

#include <memory>
#include <optional>
#include <vector>

#include "ardia/mac/ac_mac_backdrop_theme.h"
#include "ardia/mac/ac_mac_glass_layout.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "ui/gfx/native_ui_types.h"

namespace views {
class View;
class Widget;
}

namespace ardia_mac {

struct GlassPage {
  glass::Page page;
  gfx::NativeView view;
};

bool LiquidGlassAvailable();
bool GlassGroupsAvailable();

class GlassRegions {
 public:
  using Presented = base::RepeatingCallback<void(int generation)>;

  GlassRegions(views::Widget* widget, views::View* under_shell, Presented presented);
  GlassRegions(const GlassRegions&) = delete;
  GlassRegions& operator=(const GlassRegions&) = delete;
  ~GlassRegions();

  base::Value Apply(const base::DictValue& args, double shell_zoom);
  base::Value ApplyBackdrops(const base::DictValue& args, double shell_zoom);
  void SetSurface(const glass::Rect& shell_in_window,
                  std::vector<GlassPage> pages);
  void Clear();

 private:
  struct Views;

  glass::Layout Relayout();
  void LayOutThemes(const glass::Layout& layout);
  bool MountUnderShell(const glass::Placement& placement, const glass::Rect& page);
  void EmitPresented(glass::PresentedGate::Ticket ticket);

  raw_ptr<views::Widget> widget_;
  raw_ptr<views::View> under_shell_;
  std::unique_ptr<Views> views_;
  std::vector<glass::Region> regions_;
  std::vector<glass::Region> backdrops_;
  std::vector<std::optional<backdrop_theme::Theme>> themes_;
  std::vector<glass::Placement> placed_;
  std::vector<GlassPage> pages_;
  glass::Rect shell_;
  double zoom_ = 1;
  Presented presented_;
  glass::PresentedGate gate_;
  base::WeakPtrFactory<GlassRegions> weak_factory_{this};
};

}

#endif
