#include "ardia/desktop/ac_desktop_platform.h"

#include "base/check.h"
#include "base/no_destructor.h"

namespace ardia::desktop {

DesktopPlatform& Platform() {
  static base::NoDestructor<std::unique_ptr<DesktopPlatform>> platform(CreateDesktopPlatform());
  CHECK(*platform);
  return **platform;
}

}
