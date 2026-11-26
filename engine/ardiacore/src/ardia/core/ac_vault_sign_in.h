#ifndef ARDIA_CORE_AC_VAULT_SIGN_IN_H_
#define ARDIA_CORE_AC_VAULT_SIGN_IN_H_

#import <Foundation/Foundation.h>

#include <optional>
#include <string>

#include "ardia/core/ac_vault_frames.h"
#include "base/functional/callback.h"
#include "url/gurl.h"
#include "url/origin.h"

class Profile;

namespace ardiacore {

using VaultCodeReply = base::OnceCallback<void(std::optional<std::u16string>)>;
using VaultCodeProvider = base::RepeatingCallback<void(VaultCodeReply)>;

struct VaultSignInRequest {
  VaultSignInRequest();
  VaultSignInRequest(VaultSignInRequest&&);
  VaultSignInRequest& operator=(VaultSignInRequest&&);
  ~VaultSignInRequest();

  GURL url;
  url::Origin origin;
  std::u16string username;
  VaultCodeProvider code_provider;
};

using VaultSignInDone = base::OnceCallback<void(NSDictionary<NSString*, id>*)>;

base::OnceClosure StartVaultSignIn(Profile* profile,
                                   VaultSignInRequest request,
                                   VaultSignInDone done);

}

#endif
