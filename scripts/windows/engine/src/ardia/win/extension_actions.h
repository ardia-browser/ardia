#ifndef ARDIA_WIN_EXTENSION_ACTIONS_H_
#define ARDIA_WIN_EXTENSION_ACTIONS_H_

#include <windows.h>

#include "base/values.h"
#include "chrome/browser/ui/extensions/extension_popup_types.h"
#include "ui/gfx/geometry/rect.h"

class BrowserWindowInterface;

namespace extensions {
class Extension;
}

namespace content {
class WebContents;
}

namespace views {
class ViewTracker;
}

namespace ardia_win {

const char* OpenOrRunExtensionAction(BrowserWindowInterface& browser,
                                     content::WebContents& contents,
                                     HWND parent,
                                     const base::DictValue& args,
                                     views::ViewTracker& anchor);
bool ShowExtensionActionPopup(BrowserWindowInterface& browser,
                              content::WebContents& contents,
                              const extensions::Extension& extension,
                              HWND parent,
                              const gfx::Rect& location,
                              views::ViewTracker& anchor,
                              ShowPopupCallback& callback);
bool HasExtensionActionPopup(views::ViewTracker& anchor);
gfx::Rect ExtensionActionAnchorInClient(HWND parent,
                                       const base::DictValue* anchor);
void CloseExtensionActionPopup(views::ViewTracker& anchor);
void ClosePendingExtensionActionPopup(views::ViewTracker& anchor);
void DismissExtensionActionPopup(views::ViewTracker& anchor, HWND previous);
void DismissExtensionActionPopupForPress(views::ViewTracker& anchor,
                                        POINT screen,
                                        bool primary);

}

#endif
