#ifndef ARDIA_LINUX_AC_LINUX_AUTO_PIP_SERVICE_H_
#define ARDIA_LINUX_AC_LINUX_AUTO_PIP_SERVICE_H_

#include "base/functional/callback_forward.h"

namespace content {
class WebContents;
}

namespace ardiacore {

void SetLinuxAutoPictureInPicture(bool enabled);
void DepartWhenLinuxPageHidden(content::WebContents* contents, base::OnceClosure depart);
void ReturnBeforeLinuxPageHidden(content::WebContents* contents);

}

#endif
