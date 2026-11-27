#pragma once

namespace ardia_auto_pip {

struct Hold {
  bool held = false;

  bool ended(bool appAsked, bool seen) {
    if (held || appAsked || seen) return false;
    held = true;
    return true;
  }

  bool tellsChrome(bool userBack) {
    if (userBack) held = false;
    return !held;
  }
};

}
