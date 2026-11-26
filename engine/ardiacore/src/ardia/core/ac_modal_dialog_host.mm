#include "ardia/core/ac_modal_dialog_host.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <vector>

#include "base/functional/bind.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ardia/core/ac_browser.h"

namespace ardiacore {

namespace {

int g_dialog_host_observers = 0;
id g_frame_change_observer = nil;

}

gfx::Rect PageRectInHostView(NSView* host_view, content::WebContents* contents) {
  if (!host_view) {
    return gfx::Rect();
  }
  NSRect bounds = host_view.bounds;
  NSRect page = bounds;
  NSView* view = contents ? contents->GetNativeView().GetNativeNSView() : nil;
  if (view && view.window == host_view.window && view.superview &&
      [view isDescendantOf:host_view.window.contentView]) {
    page = NSIntersectionRect([view convertRect:view.bounds toView:host_view],
                              bounds);
    if (NSIsEmptyRect(page)) {
      page = bounds;
    }
  }
  const CGFloat top = host_view.isFlipped ? NSMinY(page)
                                          : NSHeight(bounds) - NSMaxY(page);
  return gfx::Rect(NSMinX(page), top, NSWidth(page), NSHeight(page));
}

gfx::Point DialogPositionInHostView(NSView* host_view,
                                    const gfx::Rect& page,
                                    const gfx::Size& size) {
  const int host_width = host_view ? NSWidth(host_view.bounds) : page.right();
  int x = page.x() + (page.width() - size.width()) / 2;
  x = std::min(x, host_width - size.width());
  x = std::max(x, 0);
  return gfx::Point(x, page.y());
}

bool WindowIsForeground(NSWindow* window) {
  if (!window || !NSApp.isActive) {
    return false;
  }
  if (NSApp.mainWindow == window) {
    return true;
  }
  for (NSWindow* key = NSApp.keyWindow; key;
       key = key.parentWindow ?: key.sheetParent) {
    if (key == window) {
      return true;
    }
  }
  return false;
}

void DialogHostObserverAdded() {
  if (++g_dialog_host_observers != 1 || g_frame_change_observer) {
    return;
  }
  g_frame_change_observer = [NSNotificationCenter.defaultCenter
      addObserverForName:NSViewFrameDidChangeNotification
                  object:nil
                   queue:nil
              usingBlock:^(NSNotification* notification) {
                NSView* view = notification.object;
                if (![view isKindOfClass:[NSView class]]) {
                  return;
                }
                if (WindowHost* host = WindowHost::ForNSWindow(view.window)) {
                  host->ScheduleDialogPositionUpdate();
                }
              }];
}

void DialogHostObserverRemoved() {
  if (g_dialog_host_observers == 0 || --g_dialog_host_observers != 0 ||
      !g_frame_change_observer) {
    return;
  }
  [NSNotificationCenter.defaultCenter removeObserver:g_frame_change_observer];
  g_frame_change_observer = nil;
}

class ACTabDialogHost::Anchor
    : public content::WebContentsUserData<ACTabDialogHost::Anchor> {
 public:
  ~Anchor() override {
    ACTabDialogHost* host = host_.get();
    host_ = nullptr;
    host->ContentsDestroyed();
  }

  ACTabDialogHost* host() const { return host_; }

 private:
  friend class content::WebContentsUserData<Anchor>;

  explicit Anchor(content::WebContents* contents)
      : content::WebContentsUserData<Anchor>(*contents),
        host_(new ACTabDialogHost(contents)) {}

  raw_ptr<ACTabDialogHost> host_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ACTabDialogHost::Anchor);

ACTabDialogHost* ACTabDialogHost::GetOrCreateForWebContents(
    content::WebContents* contents) {
  return Anchor::GetOrCreateForWebContents(contents)->host();
}

ACTabDialogHost* ACTabDialogHost::FromWebContents(
    content::WebContents* contents) {
  Anchor* anchor = contents ? Anchor::FromWebContents(contents) : nullptr;
  return anchor ? anchor->host() : nullptr;
}

ACTabDialogHost::ACTabDialogHost(content::WebContents* contents)
    : contents_(contents) {}

ACTabDialogHost::~ACTabDialogHost() = default;

void ACTabDialogHost::ContentsDestroyed() {
  contents_ = nullptr;
  if (!observers_.empty()) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostNonNestableTask(
        FROM_HERE, base::BindOnce(&ACTabDialogHost::CloseOrphanedDialogs,
                                  weak_factory_.GetWeakPtr()));
  }
  DeleteIfOrphaned();
}

void ACTabDialogHost::CloseOrphanedDialogs() {
  for (auto& observer : observers_) {
    observer.OnHostDestroying();
  }
  std::vector<web_modal::ModalDialogHostObserver*> remaining;
  for (auto& observer : observers_) {
    remaining.push_back(&observer);
  }
  for (auto* observer : remaining) {
    RemoveObserver(observer);
  }
  DeleteIfOrphaned();
}

void ACTabDialogHost::DeleteIfOrphaned() {
  if (contents_ || !observers_.empty() || deletion_scheduled_) {
    return;
  }
  deletion_scheduled_ = true;
  base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
}

WindowHost* ACTabDialogHost::window_host() const {
  auto* tab = contents_ ? tabs::TabInterface::MaybeGetFromContents(
                             contents_.get())
                       : nullptr;
  return tab ? WindowHost::ForBrowser(tab->GetBrowserWindowInterface())
             : nullptr;
}

gfx::NativeView ACTabDialogHost::GetHostView() const {
  WindowHost* host = window_host();
  return host ? gfx::NativeView(host->host_view()) : gfx::NativeView();
}

gfx::Point ACTabDialogHost::GetDialogPosition(const gfx::Size& size) {
  WindowHost* host = window_host();
  NSView* host_view = host ? host->host_view() : nil;
  return DialogPositionInHostView(
      host_view, PageRectInHostView(host_view, contents_.get()), size);
}

bool ACTabDialogHost::ShouldActivateDialog() const {
  auto* tab = contents_ ? tabs::TabInterface::MaybeGetFromContents(
                             contents_.get())
                       : nullptr;
  WindowHost* host = window_host();
  return tab && tab->GetBrowserWindowInterface() && host &&
         GetLastActiveBrowserWindowInterfaceWithAnyProfile() ==
             tab->GetBrowserWindowInterface() &&
         WindowIsForeground(host->ns_window());
}

gfx::Size ACTabDialogHost::GetMaximumDialogSize() {
  WindowHost* host = window_host();
  return PageRectInHostView(host ? host->host_view() : nil, contents_.get())
      .size();
}

void ACTabDialogHost::AddObserver(web_modal::ModalDialogHostObserver* observer) {
  if (observers_.HasObserver(observer)) {
    return;
  }
  observers_.AddObserver(observer);
  DialogHostObserverAdded();
}

void ACTabDialogHost::RemoveObserver(
    web_modal::ModalDialogHostObserver* observer) {
  if (!observers_.HasObserver(observer)) {
    return;
  }
  observers_.RemoveObserver(observer);
  DialogHostObserverRemoved();
  DeleteIfOrphaned();
}

void ACTabDialogHost::NotifyPositionRequiresUpdate() {
  observers_.Notify(
      &web_modal::ModalDialogHostObserver::OnPositionRequiresUpdate);
}

}
