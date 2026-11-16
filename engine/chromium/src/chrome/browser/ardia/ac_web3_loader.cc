// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_web3.h"

#include <memory>
#include <string>
#include <utility>

#include "base/byte_size.h"
#include "base/functional/bind.h"
#include "base/memory/self_deleting.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/ardia/ac_web3_internal.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/receiver.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "mojo/public/cpp/system/data_pipe_producer.h"
#include "mojo/public/cpp/system/string_data_source.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "net/http/http_version.h"
#include "services/network/public/cpp/http_request_headers_update_params.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/self_deleting_url_loader_factory.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace ardia {
namespace {

using web3_internal::Page;
using web3_internal::Resolver;
using web3_internal::Result;

constexpr char kWeb3Policy[] =
    "default-src web3: data: blob: 'unsafe-inline' 'unsafe-eval' "
    "'wasm-unsafe-eval'";

class Web3Loader : public network::mojom::URLLoader {
 public:
  Web3Loader(mojo::PendingReceiver<network::mojom::URLLoader> receiver,
             mojo::PendingRemote<network::mojom::URLLoaderClient> client,
             scoped_refptr<network::SharedURLLoaderFactory> rpc_factory,
             const GURL& url,
             base::WeakPtr<Profile> reported_to)
      : receiver_(this, std::move(receiver)),
        client_(std::move(client)),
        reported_to_(std::move(reported_to)) {
    receiver_.set_disconnect_handler(
        base::BindOnce(&Web3Loader::Close, base::Unretained(this)));
    client_.set_disconnect_handler(
        base::BindOnce(&Web3Loader::Close, base::Unretained(this)));
    resolver_ = std::make_unique<Resolver>(
        std::move(rpc_factory), url,
        base::BindOnce(&Web3Loader::Resolved, base::Unretained(this)));
  }

  void Start() { resolver_->Start(); }

  Web3Loader(const Web3Loader&) = delete;
  Web3Loader& operator=(const Web3Loader&) = delete;
  ~Web3Loader() override = default;

  void FollowRedirect(network::HttpRequestHeadersUpdateParams headers_update_params,
                      const std::optional<GURL>& new_url) override {}
  void SetPriority(net::RequestPriority priority,
                   int32_t intra_priority_value) override {}

 private:
  void Close() { delete this; }

  void Resolved(Result result) {
    if (reported_to_) {
      Emit("engine.web3Load", reported_to_.get(),
           base::DictValue()
               .Set("mode", result.mode)
               .Set("outcome", web3_internal::OutcomeName(result.outcome)));
    }
    Page page = std::move(result.page);
    const std::string status = base::NumberToString(page.status);
    const std::string content_type =
        page.charset.empty() ? page.mime_type : page.mime_type + "; charset=" + page.charset;
    net::HttpResponseHeaders::Builder builder(net::HttpVersion(1, 1), status);
    builder.AddHeader("Content-Type", content_type);
    builder.AddHeader("Content-Security-Policy", kWeb3Policy);
    for (const auto& [name, value] : page.headers) {
      if (!base::EqualsCaseInsensitiveASCII(name, "content-type")) {
        builder.AddHeader(name, value);
      }
    }
    auto head = network::mojom::URLResponseHead::New();
    head->headers = builder.Build();
    head->mime_type = page.mime_type;
    head->charset = page.charset;
    head->content_length = static_cast<int64_t>(page.body.size());

    mojo::ScopedDataPipeProducerHandle producer;
    mojo::ScopedDataPipeConsumerHandle consumer;
    if (mojo::CreateDataPipe(nullptr, producer, consumer) != MOJO_RESULT_OK) {
      client_->OnComplete(
          network::URLLoaderCompletionStatus(net::ERR_INSUFFICIENT_RESOURCES));
      return Close();
    }
    client_->OnReceiveResponse(std::move(head), std::move(consumer), std::nullopt);
    body_size_ = page.body.size();
    producer_ = std::make_unique<mojo::DataPipeProducer>(std::move(producer));
    producer_->Write(
        std::make_unique<mojo::StringDataSource>(
            page.body, mojo::StringDataSource::AsyncWritingMode::
                           STRING_MAY_BE_INVALIDATED_BEFORE_COMPLETION),
        base::BindOnce(&Web3Loader::Written, base::Unretained(this)));
  }

  void Written(MojoResult result) {
    network::URLLoaderCompletionStatus status(
        result == MOJO_RESULT_OK ? net::OK : net::ERR_FAILED);
    status.encoded_data_length = base::ByteSize(body_size_);
    status.encoded_body_length = base::ByteSize(body_size_);
    status.decoded_body_length = base::ByteSize(body_size_);
    client_->OnComplete(status);
    Close();
  }

  mojo::Receiver<network::mojom::URLLoader> receiver_;
  mojo::Remote<network::mojom::URLLoaderClient> client_;
  base::WeakPtr<Profile> reported_to_;
  std::unique_ptr<Resolver> resolver_;
  std::unique_ptr<mojo::DataPipeProducer> producer_;
  size_t body_size_ = 0;
};

class Web3URLLoaderFactory : public network::SelfDeletingURLLoaderFactory {
 public:
  Web3URLLoaderFactory(
      content::BrowserContext* context,
      Web3Loads loads,
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      base::SelfDeletingPassKey key)
      : network::SelfDeletingURLLoaderFactory(std::move(receiver), key),
        rpc_factory_(context->GetDefaultStoragePartition()
                         ->GetURLLoaderFactoryForBrowserProcess()),
        profile_(Profile::FromBrowserContext(context)->GetWeakPtr()),
        loads_(loads) {}

  Web3URLLoaderFactory(const Web3URLLoaderFactory&) = delete;
  Web3URLLoaderFactory& operator=(const Web3URLLoaderFactory&) = delete;

 private:
  ~Web3URLLoaderFactory() override = default;

  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation)
      override {
    if (request.method != "GET" || !request.url.SchemeIs(kWeb3Scheme)) {
      mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
          ->OnComplete(network::URLLoaderCompletionStatus(
              net::ERR_METHOD_NOT_SUPPORTED));
      return;
    }
    (new Web3Loader(std::move(loader), std::move(client), rpc_factory_,
                    request.url,
                    loads_ == Web3Loads::kNavigation ? profile_ : nullptr))
        ->Start();
  }

  scoped_refptr<network::SharedURLLoaderFactory> rpc_factory_;
  base::WeakPtr<Profile> profile_;
  Web3Loads loads_;
};

}

mojo::PendingRemote<network::mojom::URLLoaderFactory> CreateWeb3URLLoaderFactory(
    content::BrowserContext* context,
    Web3Loads loads) {
  mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
  base::MakeSelfDeleting<Web3URLLoaderFactory>(
      context, loads, remote.InitWithNewPipeAndPassReceiver());
  return remote;
}

bool IsWeb3SettingsURL(const GURL& url) {
  return url == GURL("ardia://settings/web3");
}

}
