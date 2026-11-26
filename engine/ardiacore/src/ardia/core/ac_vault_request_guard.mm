#include "ardia/core/ac_vault_request_guard.h"

#include <optional>
#include <string>
#include <utility>

#include "ardia/core/ac_vault_frames.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/pending_receiver.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/receiver_set.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/net_errors.h"
#include "net/url_request/redirect_info.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/cpp/url_loader_factory_builder.h"
#include "services/network/public/mojom/early_hints.mojom.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace ardiacore {

namespace {

void Block(mojo::PendingRemote<network::mojom::URLLoaderClient> client) {
  mojo::Remote<network::mojom::URLLoaderClient> remote(std::move(client));
  remote->OnComplete(
      network::URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
}

class GuardLoader : public network::mojom::URLLoader,
                    public network::mojom::URLLoaderClient {
 public:
  GuardLoader(base::WeakPtr<VaultRequestPolicy> policy,
              VaultRequest kind,
              mojo::PendingReceiver<network::mojom::URLLoader> loader,
              mojo::PendingRemote<network::mojom::URLLoaderClient> client,
              network::mojom::URLLoaderFactory* target,
              int32_t request_id,
              uint32_t options,
              const network::ResourceRequest& request,
              const net::MutableNetworkTrafficAnnotationTag& traffic)
      : policy_(std::move(policy)),
        kind_(kind),
        receiver_(this, std::move(loader)),
        client_(std::move(client)) {
    target->CreateLoaderAndStart(target_.BindNewPipeAndPassReceiver(),
                                 request_id, options, request,
                                 client_receiver_.BindNewPipeAndPassRemote(),
                                 traffic);
    receiver_.set_disconnect_handler(
        base::BindOnce(&GuardLoader::Close, base::Unretained(this)));
    client_.set_disconnect_handler(
        base::BindOnce(&GuardLoader::Close, base::Unretained(this)));
    client_receiver_.set_disconnect_handler(
        base::BindOnce(&GuardLoader::Close, base::Unretained(this)));
  }

  void FollowRedirect(
      network::HttpRequestHeadersUpdateParams headers_update_params,
      const std::optional<GURL>& new_url) override {
    target_->FollowRedirect(std::move(headers_update_params), new_url);
  }

  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {
    target_->SetPriority(priority, intra_priority_value);
  }

  void OnReceiveEarlyHints(network::mojom::EarlyHintsPtr early_hints) override {
    client_->OnReceiveEarlyHints(std::move(early_hints));
  }

  void OnReceiveResponse(
      network::mojom::URLResponseHeadPtr head,
      mojo::ScopedDataPipeConsumerHandle body,
      std::optional<mojo_base::BigBuffer> cached_metadata) override {
    client_->OnReceiveResponse(std::move(head), std::move(body),
                               std::move(cached_metadata));
  }

  void OnReceiveRedirect(const net::RedirectInfo& redirect_info,
                         network::mojom::URLResponseHeadPtr head) override {
    VaultRequest hop = kind_;
    hop.redirect = true;
    const VaultRequestVerdict verdict =
        policy_ ? policy_->Check(redirect_info.new_url, redirect_info.new_method,
                                 hop)
                : VaultRequestVerdict::kBlock;
    if (verdict != VaultRequestVerdict::kAllow) {
      if (verdict == VaultRequestVerdict::kSecretInURL) {
        policy_->RefuseSecretInURL();
      } else if (verdict == VaultRequestVerdict::kRefuse) {
        policy_->Refuse();
      } else if (policy_) {
        policy_->NoteBlocked();
      }
      client_->OnComplete(
          network::URLLoaderCompletionStatus(net::ERR_BLOCKED_BY_CLIENT));
      Close();
      return;
    }
    client_->OnReceiveRedirect(redirect_info, std::move(head));
  }

  void OnUploadProgress(int64_t current_position,
                        int64_t total_size,
                        OnUploadProgressCallback ack_callback) override {
    client_->OnUploadProgress(current_position, total_size,
                              std::move(ack_callback));
  }

  void OnTransferSizeUpdated(int32_t transfer_size_diff) override {
    client_->OnTransferSizeUpdated(transfer_size_diff);
  }

  void OnComplete(const network::URLLoaderCompletionStatus& status) override {
    client_->OnComplete(status);
  }

 private:
  void Close() { delete this; }

  base::WeakPtr<VaultRequestPolicy> policy_;
  const VaultRequest kind_;
  mojo::Receiver<network::mojom::URLLoader> receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;
  mojo::Remote<network::mojom::URLLoader> target_;
  mojo::Receiver<network::mojom::URLLoaderClient> client_receiver_{this};
};

class GuardFactory : public network::mojom::URLLoaderFactory {
 public:
  GuardFactory(base::WeakPtr<VaultRequestPolicy> policy,
               bool navigation,
               content::FrameTreeNodeId frame,
               mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
               mojo::PendingRemote<network::mojom::URLLoaderFactory> target)
      : policy_(std::move(policy)),
        navigation_(navigation),
        frame_(frame),
        target_(std::move(target)) {
    receivers_.Add(this, std::move(receiver));
    receivers_.set_disconnect_handler(
        base::BindRepeating(&GuardFactory::Disconnected,
                            base::Unretained(this)));
    target_.set_disconnect_handler(
        base::BindOnce(&GuardFactory::Close, base::Unretained(this)));
  }

  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation)
      override {
    VaultRequest kind;
    kind.navigation = navigation_;
    kind.keepalive = request.keepalive;
    kind.frame = frame_;
    const VaultRequestVerdict verdict =
        policy_ ? policy_->Check(request.url, request.method, kind)
                : VaultRequestVerdict::kBlock;
    if (verdict != VaultRequestVerdict::kAllow) {
      if (verdict == VaultRequestVerdict::kSecretInURL) {
        policy_->RefuseSecretInURL();
      } else if (verdict == VaultRequestVerdict::kRefuse) {
        policy_->Refuse();
      } else if (policy_) {
        policy_->NoteBlocked();
      }
      Block(std::move(client));
      return;
    }
    new GuardLoader(policy_, kind, std::move(loader), std::move(client),
                    target_.get(), request_id, options, request,
                    traffic_annotation);
  }

  void Clone(mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver)
      override {
    receivers_.Add(this, std::move(receiver));
  }

 private:
  void Disconnected() {
    if (receivers_.empty()) {
      Close();
    }
  }

  void Close() { delete this; }

  base::WeakPtr<VaultRequestPolicy> policy_;
  const bool navigation_;
  const content::FrameTreeNodeId frame_;
  mojo::ReceiverSet<network::mojom::URLLoaderFactory> receivers_;
  mojo::Remote<network::mojom::URLLoaderFactory> target_;
};

}

VaultRequestPolicy::VaultRequestPolicy(
    url::Origin origin,
    base::RepeatingClosure refused,
    base::RepeatingCallback<bool(const GURL&)> carries_secret,
    base::RepeatingClosure secret_in_url)
    : origin_(std::move(origin)),
      site_(origin_),
      refused_(std::move(refused)),
      carries_secret_(std::move(carries_secret)),
      secret_in_url_(std::move(secret_in_url)) {}

void VaultRequestPolicy::SetArmed(std::set<content::FrameTreeNodeId> frames) {
  armed_ = std::move(frames);
  filled_ |= !armed_.empty();
}

VaultRequestPolicy::~VaultRequestPolicy() = default;

VaultRequestVerdict VaultRequestPolicy::Check(const GURL& url,
                                              std::string_view method,
                                              const VaultRequest& request) const {
  if (request.navigation && armed_.contains(request.frame) &&
      (base::EqualsCaseInsensitiveASCII(method, "GET") ||
       base::EqualsCaseInsensitiveASCII(method, "HEAD")) &&
      carries_secret_ && carries_secret_.Run(url)) {
    return VaultRequestVerdict::kSecretInURL;
  }
  if (url.SchemeIsHTTPOrHTTPS() &&
      url::Origin::Create(url).IsSameOriginWith(origin_)) {
    return VaultRequestVerdict::kAllow;
  }
  const bool carries_body = !base::EqualsCaseInsensitiveASCII(method, "GET") &&
                            !base::EqualsCaseInsensitiveASCII(method, "HEAD");
  if (request.navigation) {
    if (!armed_.contains(request.frame)) {
      return VaultRequestVerdict::kAllow;
    }
    return !request.redirect || carries_body ? VaultRequestVerdict::kRefuse
                                             : VaultRequestVerdict::kAllow;
  }
  if (!carries_body) {
    return VaultRequestVerdict::kAllow;
  }
  if (request.keepalive && filled_) {
    return VaultRequestVerdict::kBlock;
  }
  if (armed() && !(url.SchemeIsHTTPOrHTTPS() && net::SchemefulSite(url) == site_)) {
    return VaultRequestVerdict::kBlock;
  }
  return VaultRequestVerdict::kAllow;
}

void VaultRequestPolicy::Refuse() {
  if (refused_) {
    refused_.Run();
  }
}

void VaultRequestPolicy::RefuseSecretInURL() {
  if (secret_in_url_) {
    secret_in_url_.Run();
  }
}

void GuardVaultRequests(content::BrowserContext* context,
                        content::RenderFrameHost* frame,
                        bool navigation,
                        network::URLLoaderFactoryBuilder& factory_builder) {
  if (!IsVaultBrowserContext(context)) {
    return;
  }
  auto [receiver, target] = factory_builder.Append();
  new GuardFactory(VaultRequestPolicyFor(context), navigation,
                   frame ? frame->GetFrameTreeNodeId()
                         : content::FrameTreeNodeId(),
                   std::move(receiver), std::move(target));
}

}
