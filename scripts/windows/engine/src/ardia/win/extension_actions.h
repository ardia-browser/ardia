#ifndef ARDIA_WIN_EXTENSION_ACTIONS_H_
#define ARDIA_WIN_EXTENSION_ACTIONS_H_

#include <windows.h>

#include "base/values.h"

class BrowserWindowInterface;

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
void CloseExtensionActionPopup(views::ViewTracker& anchor);
void DismissExtensionActionPopup(views::ViewTracker& anchor,
                                 HWND previous,
                                 bool mouse_activated);

}

#endif
