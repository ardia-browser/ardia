#include "ardia/win/extension_actions.h"

#include <memory>
#include <string>
#include <utility>

#include "base/memory/scoped_refptr.h"
#include "base/numerics/safe_conversions.h"
#include "chrome/browser/extensions/extension_action_runner.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/extensions/extension_view_host_factory.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/views/extensions/extension_popup.h"
#include "components/sessions/content/session_tab_helper.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_util.h"
#include "extensions/common/extension.h"
#include "ui/base/base_window.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/display/win/screen_win.h"
#include "ui/views/view.h"
#include "ui/views/view_tracker.h"
#include "ui/views/widget/widget.h"
#include "ui/views/win/hwnd_util.h"
#include "url/gurl.h"

namespace ardia_win {
namespace {

class PopupAnchor : public views::View {
  METADATA_HEADER(PopupAnchor, views::View)

 public:
  PopupAnchor() { SetCanProcessEventsWithinSubtree(false); }

  void SetLocation(HWND parent, gfx::Rect rect, std::string extension_id) {
    parent_ = parent;
    rect_ = rect;
    extension_id_ = std::move(extension_id);
  }

  const std::string& extension_id() const { return extension_id_; }

  bool ContainsScreenPoint(POINT screen) const {
    return ::ScreenToClient(parent_, &screen) &&
           rect_.Contains(gfx::Point(screen.x, screen.y));
  }

  bool HasPrimaryPress() const {
    const int button =
        ::GetSystemMetrics(SM_SWAPBUTTON) ? VK_RBUTTON : VK_LBUTTON;
    POINT screen;
    return (::GetAsyncKeyState(button) & 0x8000) && ::GetCursorPos(&screen) &&
           ContainsScreenPoint(screen);
  }

  gfx::Rect GetAnchorBoundsInScreen() const override {
    POINT origin{rect_.x(), rect_.y()};
    if (!::ClientToScreen(parent_, &origin)) {
      return GetBoundsInScreen();
    }
    return display::win::GetScreenWin()->ScreenToDIPRect(
        parent_, gfx::Rect(origin.x, origin.y, rect_.width(), rect_.height()));
  }

 private:
  HWND parent_ = nullptr;
  gfx::Rect rect_;
  std::string extension_id_;
};

BEGIN_METADATA(PopupAnchor)
END_METADATA

views::BubbleDialogDelegate* AnchoredPopup(views::ViewTracker& anchor) {
  if (!anchor.view()) {
    return nullptr;
  }
  auto* dialog = views::BubbleDialogDelegate::GetAnchoredDialog(
      views::BubbleAnchor(anchor.view()));
  auto* widget = dialog ? dialog->GetWidget() : nullptr;
  return widget && !widget->IsClosed() ? dialog : nullptr;
}

}

gfx::Rect ExtensionActionAnchorInClient(HWND parent,
                                       const base::DictValue* anchor) {
  RECT client{};
  if (!anchor || !::GetClientRect(parent, &client)) {
    return {};
  }
  const double scale = ::GetDpiForWindow(parent) / 96.0;
  const auto pixels = [anchor, scale](const char* field) {
    return base::ClampRound(anchor->FindDouble(field).value_or(0) * scale);
  };
  gfx::Rect rect(pixels("x"), pixels("y"), pixels("width"), pixels("height"));
  rect.Intersect(gfx::Rect(client.right, client.bottom));
  return rect;
}

const char* OpenOrRunExtensionAction(BrowserWindowInterface& browser,
                                     content::WebContents& contents,
                                     HWND parent,
                                     const base::DictValue& args,
                                     views::ViewTracker& anchor) {
  const std::string* id = args.FindString("extensionId");
  auto* context = contents.GetBrowserContext();
  auto* registry = extensions::ExtensionRegistry::Get(context);
  const scoped_refptr<const extensions::Extension> extension(
      id && registry ? registry->enabled_extensions().GetByID(*id) : nullptr);
  auto* runner =
      extensions::ExtensionActionRunner::GetForWebContents(&contents);
  if (!extension || !runner ||
      (context->IsOffTheRecord() &&
       !extensions::util::IsIncognitoEnabled(*id, context))) {
    return "none";
  }

  auto* manager = extensions::ExtensionActionManager::Get(context);
  auto* action = manager ? manager->GetExtensionAction(*extension) : nullptr;
  const int tab_id = sessions::SessionTabHelper::IdForTab(&contents).id();
  if (!action ||
      (!action->GetIsVisible(tab_id) && !runner->GetBlockedActions(*id))) {
    return "none";
  }
  if (auto* open = AnchoredPopup(anchor)) {
    const bool same =
        static_cast<PopupAnchor*>(anchor.view())->extension_id() == *id;
    open->GetWidget()->Close();
    if (same) {
      return "none";
    }
  }
  using ShowAction = extensions::ExtensionAction::ShowAction;
  switch (runner->RunAction(extension.get(), true)) {
    case ShowAction::kNone:
      return "none";
    case ShowAction::kToggleSidePanel:
      return "sidePanel";
    case ShowAction::kShowPopup:
      break;
  }

  ShowPopupCallback callback;
  gfx::Rect location =
      ExtensionActionAnchorInClient(parent, args.FindDict("anchor"));
  if (location.IsEmpty()) {
    RECT client{};
    ::GetClientRect(parent, &client);
    location = gfx::Rect(client.right, 0, 1, 1);
  }
  return ShowExtensionActionPopup(
             browser, contents, *extension, parent, location, anchor, callback)
             ? "nativePopup"
             : "none";
}

bool ShowExtensionActionPopup(BrowserWindowInterface& browser,
                              content::WebContents& contents,
                              const extensions::Extension& extension,
                              HWND parent,
                              const gfx::Rect& location,
                              views::ViewTracker& anchor,
                              ShowPopupCallback& callback) {
  auto* context = contents.GetBrowserContext();
  auto* registry = extensions::ExtensionRegistry::Get(context);
  if (!registry || !registry->enabled_extensions().Contains(extension.id()) ||
      (context->IsOffTheRecord() &&
       !extensions::util::IsIncognitoEnabled(extension.id(), context))) {
    return false;
  }
  auto* manager = extensions::ExtensionActionManager::Get(context);
  auto* action = manager ? manager->GetExtensionAction(extension) : nullptr;
  const int tab_id = sessions::SessionTabHelper::IdForTab(&contents).id();
  const GURL url = action ? action->GetPopupUrl(tab_id) : GURL();
  if (!url.is_valid()) {
    return false;
  }
  auto* window = browser.GetWindow();
  auto* widget =
      window ? views::Widget::GetWidgetForNativeView(window->GetNativeWindow())
             : nullptr;
  auto* view = widget ? widget->GetContentsView() : nullptr;
  if (!view) {
    return false;
  }
  auto host = extensions::ExtensionViewHostFactory::CreatePopupHost(
      extension, url, &browser);
  if (!host) {
    return false;
  }
  if (!anchor.view()) {
    anchor.SetView(view->AddChildView(std::make_unique<PopupAnchor>()));
  }
  auto* popup_anchor = static_cast<PopupAnchor*>(anchor.view());
  popup_anchor->SetLocation(parent, location, extension.id());
  ExtensionPopup::ShowPopup(&browser, std::move(host),
                            views::BubbleAnchor(popup_anchor),
                            views::BubbleBorder::TOP_RIGHT,
                            PopupShowAction::kShow, std::move(callback));
  if (auto* popup = AnchoredPopup(anchor)) {
    popup->SetUseAnchorWindowBounds(false);
    popup->SizeToContents();
  }
  return true;
}

bool HasExtensionActionPopup(views::ViewTracker& anchor) {
  return AnchoredPopup(anchor) != nullptr;
}

void CloseExtensionActionPopup(views::ViewTracker& anchor) {
  if (auto* popup = AnchoredPopup(anchor)) {
    popup->GetWidget()->Close();
  }
}

void ClosePendingExtensionActionPopup(views::ViewTracker& anchor) {
  if (auto* popup = AnchoredPopup(anchor);
      popup && !popup->GetWidget()->IsVisible()) {
    popup->GetWidget()->Close();
  }
}

void DismissExtensionActionPopup(views::ViewTracker& anchor, HWND previous) {
  auto* popup = AnchoredPopup(anchor);
  if (!popup || !previous ||
      views::HWNDForWidget(popup->GetWidget()) != previous) {
    return;
  }
  if (static_cast<PopupAnchor*>(anchor.view())->HasPrimaryPress()) {
    return;
  }
  popup->GetWidget()->Close();
}

void DismissExtensionActionPopupForPress(views::ViewTracker& anchor,
                                        POINT screen,
                                        bool primary) {
  auto* popup = AnchoredPopup(anchor);
  if (!popup || (primary &&
                 static_cast<PopupAnchor*>(anchor.view())->ContainsScreenPoint(
                     screen))) {
    return;
  }
  popup->GetWidget()->Close();
}

}
