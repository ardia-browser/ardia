// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_WEB3_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_WEB3_INTERNAL_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "chrome/browser/ardia/ac_web3_codec.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/mojom/url_response_head.mojom-forward.h"
#include "url/gurl.h"

namespace network {
class SharedURLLoaderFactory;
class SimpleURLLoader;
}

namespace ardia::web3_internal {

std::optional<GURL> RpcFor(uint64_t chain);
void ClearCaches();

struct Page {
  int status = 200;
  std::string mime_type;
  std::string charset;
  std::string body;
  std::vector<std::pair<std::string, std::string>> headers;
};

enum class Outcome {
  kOk,
  kNoRpc,
  kRpcFailed,
  kReverted,
  kNotContract,
  kNotFound,
  kBadUrl,
  kUnsupportedMode,
  kBadResponse,
};

struct Result {
  Page page;
  Outcome outcome = Outcome::kOk;
  std::string mode;
};

const char* OutcomeName(Outcome outcome);

class Rpc {
 public:
  struct Answer {
    enum class Kind { kOk, kReverted, kFailed };
    Kind kind = Kind::kFailed;
    web3::Bytes data;
  };
  using Done = base::OnceCallback<void(Answer)>;

  explicit Rpc(scoped_refptr<network::SharedURLLoaderFactory> factory);
  Rpc(const Rpc&) = delete;
  Rpc& operator=(const Rpc&) = delete;
  ~Rpc();

  void Call(const GURL& endpoint,
            std::string_view to,
            std::string_view data,
            Done done);
  void GetCode(const GURL& endpoint, std::string_view address, Done done);

 private:
  void Send(const GURL& endpoint, std::string body, Done done);
  void Redirected(const GURL& from,
                  const net::RedirectInfo& redirect,
                  const network::mojom::URLResponseHead& head,
                  std::vector<std::string>* removed_headers);
  void Loaded(std::optional<std::string> body);

  scoped_refptr<network::SharedURLLoaderFactory> factory_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  GURL endpoint_;
  Done done_;
};

class Resolver {
 public:
  using Done = base::OnceCallback<void(Result)>;

  Resolver(scoped_refptr<network::SharedURLLoaderFactory> factory,
           GURL url,
           Done done);
  Resolver(const Resolver&) = delete;
  Resolver& operator=(const Resolver&) = delete;
  ~Resolver();

  void Start();

 private:
  void ResolveName();
  void GotResolver(Rpc::Answer answer);
  void GotContentContract(Rpc::Answer answer);
  void GotAddress(Rpc::Answer answer);
  void ResolveMode();
  void GotMode(Rpc::Answer answer);
  void GotCode(Rpc::Answer answer);
  void Request();
  void GotResource(Rpc::Answer answer);
  void GotAuto(Rpc::Answer answer);
  bool EnsureRpc(uint64_t chain);
  void Fail(Outcome outcome, int status, std::string title, std::string detail);
  void Finish(Result result);

  Rpc rpc_;
  GURL url_;
  Done done_;
  uint64_t chain_ = 1;
  GURL endpoint_;
  std::string name_;
  web3::Bytes node_;
  web3::Bytes name_resolver_;
  web3::Bytes address_;
  web3::Mode mode_ = web3::Mode::kAuto;
  web3::AutoCall auto_call_;
};

}

#endif
