// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_OWNER_WINDOW_H_
#define ARDIA_LINUX_MODULES_OWNER_WINDOW_H_

#include <string_view>

namespace views {
class Widget;
}

namespace ardia_linux {

views::Widget* OwnerWidget(std::string_view window_id = {});

}

#endif
