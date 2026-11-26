#ifndef ARDIA_CORE_AC_MODAL_DIALOG_HOST_H_
#define ARDIA_CORE_AC_MODAL_DIALOG_HOST_H_

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/observer_list.h"
#include "base/task/sequenced_task_runner_helpers.h"
#include "components/web_modal/web_contents_modal_dialog_host.h"
#include "ui/gfx/geometry/point.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/size.h"

@class NSView;
@class NSWindow;

namespace content {
class WebContents;
}

namespace ardiacore {

class WindowHost;

gfx::Rect PageRectInHostView(NSView* host_view, content::WebContents* contents);
gfx::Point DialogPositionInHostView(NSView* host_view,
                                    const gfx::Rect& page,
                                    const gfx::Size& size);

bool WindowIsForeground(NSWindow* window);
void DialogHostObserverAdded();
void DialogHostObserverRemoved();

class ACTabDialogHost : public web_modal::WebContentsModalDialogHost {
 public:
  ACTabDialogHost(const ACTabDialogHost&) = delete;
  ACTabDialogHost& operator=(const ACTabDialogHost&) = delete;

  static ACTabDialogHost* GetOrCreateForWebContents(
      content::WebContents* contents);
  static ACTabDialogHost* FromWebContents(content::WebContents* contents);

  gfx::NativeView GetHostView() const override;
  gfx::Point GetDialogPosition(const gfx::Size& size) override;
  bool ShouldActivateDialog() const override;
  gfx::Size GetMaximumDialogSize() override;
  void AddObserver(web_modal::ModalDialogHostObserver* observer) override;
  void RemoveObserver(web_modal::ModalDialogHostObserver* observer) override;
  void NotifyPositionRequiresUpdate() override;

 private:
  class Anchor;
  friend class base::DeleteHelper<ACTabDialogHost>;

  explicit ACTabDialogHost(content::WebContents* contents);
  ~ACTabDialogHost() override;

  void ContentsDestroyed();
  void CloseOrphanedDialogs();
  void DeleteIfOrphaned();
  WindowHost* window_host() const;

  raw_ptr<content::WebContents> contents_;
  base::ObserverList<web_modal::ModalDialogHostObserver> observers_;
  bool deletion_scheduled_ = false;
  base::WeakPtrFactory<ACTabDialogHost> weak_factory_{this};
};

}

#endif
