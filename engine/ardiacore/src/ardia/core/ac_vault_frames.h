#ifndef ARDIA_CORE_AC_VAULT_FRAMES_H_
#define ARDIA_CORE_AC_VAULT_FRAMES_H_

#include "base/memory/weak_ptr.h"

class GURL;

namespace content {
class BrowserContext;
class RenderFrameHost;
class WebContents;
}

namespace ardiacore {

class VaultRequestPolicy;

bool IsVaultBrowserContext(content::BrowserContext* context);
bool IsVaultSignInFrame(content::RenderFrameHost* frame);
void ClearFilledPasswords(content::WebContents* contents);
void NoteVaultPasskeyRequest(content::RenderFrameHost* frame);
void NoteVaultAuthChallenge(content::WebContents* contents,
                            bool proxy,
                            bool main_frame,
                            const GURL& url);
base::WeakPtr<VaultRequestPolicy> VaultRequestPolicyFor(
    content::BrowserContext* context);

}

#endif
