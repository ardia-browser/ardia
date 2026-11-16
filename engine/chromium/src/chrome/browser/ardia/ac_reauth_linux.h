// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_REAUTH_LINUX_H_
#define CHROME_BROWSER_ARDIA_AC_REAUTH_LINUX_H_

#include <string>

#include "base/functional/callback.h"

class Profile;

namespace ardia {

void ProbeReauth(base::OnceCallback<void(bool available, std::string reason)> done);

struct ReauthFallback {
  base::RepeatingCallback<bool()> available;
  base::RepeatingCallback<void(Profile*, const std::u16string& purpose,
                               base::OnceCallback<void(bool granted, bool cancelled)>)>
      confirm;
};

void SetReauthFallback(ReauthFallback fallback);

}

#endif
