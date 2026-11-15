// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_OWNER_CHECK_H_
#define CHROME_BROWSER_ARDIA_AC_OWNER_CHECK_H_

#include "base/functional/callback_forward.h"

namespace ardia {

enum class OwnerCheckPurpose {
  kShowPasswords,
  kEditPasswords,
  kExportPasswords,
  kPaymentMethods,
};

using OwnerCheck = void (*)(OwnerCheckPurpose purpose,
                            base::OnceCallback<void(bool granted)> done);

void SetOwnerCheck(OwnerCheck check);

}

#endif
