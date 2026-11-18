// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_REAUTH_LINUX_H_
#define CHROME_BROWSER_ARDIA_AC_REAUTH_LINUX_H_

#include <string>

#include "base/functional/callback.h"
#include "chrome/browser/ardia/ac_reauth_linux_policy.h"

class Profile;

namespace ardia {

void ProbeReauth(base::OnceCallback<void(bool available, std::string reason)> done);

using ReauthFallbackAnswer = base::OnceCallback<void(reauth_linux::Outcome)>;

struct ReauthFallback {
  base::RepeatingCallback<bool()> available;
  base::RepeatingCallback<void(Profile*, const std::u16string& purpose, ReauthFallbackAnswer)> confirm;
};

void SetReauthFallback(ReauthFallback fallback);

}

#endif
