#ifndef ARDIA_MAC_AC_MAC_WINDOW_H_
#define ARDIA_MAC_AC_MAC_WINDOW_H_

#include "ardia/mac/ac_mac_window_layout.h"

namespace views {
class Widget;
}

namespace ardia_mac {

void ApplyShellWindowStyle(views::Widget* widget);
void SetTrafficLights(views::Widget* widget, const window::Lights& lights);
void KeepMinimumSize(views::Widget* widget);
void ShowWithoutActivating(views::Widget* widget, views::Widget* behind);

}

#endif
