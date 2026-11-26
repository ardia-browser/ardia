#ifndef ARDIA_CORE_AC_VAULT_REQUEST_GUARD_H_
#define ARDIA_CORE_AC_VAULT_REQUEST_GUARD_H_

#include <set>
#include <string_view>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "content/public/browser/frame_tree_node_id.h"
#include "net/base/schemeful_site.h"
#include "url/origin.h"

class GURL;

namespace content {
class BrowserContext;
class RenderFrameHost;
}

namespace network {
class URLLoaderFactoryBuilder;
}

namespace ardiacore {

enum class VaultRequestVerdict { kAllow, kBlock, kRefuse, kSecretInURL };

struct VaultRequest {
  bool navigation = false;
  bool redirect = false;
  bool keepalive = false;
  content::FrameTreeNodeId frame;
};

class VaultRequestPolicy {
 public:
  VaultRequestPolicy(url::Origin origin,
                     base::RepeatingClosure refused,
                     base::RepeatingCallback<bool(const GURL&)> carries_secret,
                     base::RepeatingClosure secret_in_url);
  ~VaultRequestPolicy();
  VaultRequestPolicy(const VaultRequestPolicy&) = delete;
  VaultRequestPolicy& operator=(const VaultRequestPolicy&) = delete;

  void SetArmed(std::set<content::FrameTreeNodeId> frames);
  bool armed() const { return !armed_.empty(); }
  int blocked() const { return blocked_; }
  void NoteBlocked() { ++blocked_; }
  VaultRequestVerdict Check(const GURL& url,
                            std::string_view method,
                            const VaultRequest& request) const;
  void Refuse();
  void RefuseSecretInURL();
  base::WeakPtr<VaultRequestPolicy> GetWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

 private:
  const url::Origin origin_;
  const net::SchemefulSite site_;
  base::RepeatingClosure refused_;
  base::RepeatingCallback<bool(const GURL&)> carries_secret_;
  base::RepeatingClosure secret_in_url_;
  std::set<content::FrameTreeNodeId> armed_;
  bool filled_ = false;
  int blocked_ = 0;
  base::WeakPtrFactory<VaultRequestPolicy> weak_factory_{this};
};

void GuardVaultRequests(content::BrowserContext* context,
                        content::RenderFrameHost* frame,
                        bool navigation,
                        network::URLLoaderFactoryBuilder& factory_builder);

}

#endif
