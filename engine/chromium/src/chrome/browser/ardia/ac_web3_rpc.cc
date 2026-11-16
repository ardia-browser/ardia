// Copyright 2026 Ardia. Apache-2.0.

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/ardia/ac_web3_internal.h"
#include "net/base/load_flags.h"
#include "net/base/url_util.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/fetch_api.mojom-shared.h"

namespace ardia::web3_internal {
namespace {

constexpr base::TimeDelta kRpcTimeout = base::Seconds(30);

constexpr net::NetworkTrafficAnnotationTag kRpcAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_web3_rpc", R"(
      semantics {
        sender: "Ardia web3:// pages"
        description:
          "Reads a web3:// page from a smart contract with eth_call, through "
          "the Ethereum RPC the user set for that chain."
        trigger: "The user opens a web3:// URL, or a web3:// page loads one."
        data: "The contract address, the call data made from the URL's path "
              "and query, and ENS names being resolved."
        destination: OTHER
        destination_other: "The RPC URL the user set in Settings."
      }
      policy {
        cookies_allowed: NO
        setting: "Settings > Advanced > web3:// RPC. No RPC is set by default."
        policy_exception_justification: "Not implemented."
      })");

std::map<uint64_t, GURL>& Rpcs() {
  static base::NoDestructor<std::map<uint64_t, GURL>> rpcs;
  return *rpcs;
}

bool UsableRpcUrl(const GURL& url) {
  if (!url.is_valid() || url.has_ref()) return false;
  if (url.SchemeIs("https")) return true;
  return url.SchemeIs("http") && net::IsLocalhost(url);
}

bool IsRevert(const base::DictValue& error) {
  const std::optional<int> code = error.FindInt("code");
  const std::string* message = error.FindString("message");
  return code == 3 ||
         (message && base::ToLowerASCII(*message).find("revert") != std::string::npos);
}

}

std::optional<GURL> RpcFor(uint64_t chain) {
  auto it = Rpcs().find(chain);
  if (it == Rpcs().end()) return std::nullopt;
  return it->second;
}

Rpc::Rpc(scoped_refptr<network::SharedURLLoaderFactory> factory)
    : factory_(std::move(factory)) {}

Rpc::~Rpc() = default;

void Rpc::Call(const GURL& endpoint,
               std::string_view to,
               std::string_view data,
               Done done) {
  base::ListValue params;
  params.Append(base::DictValue().Set("to", web3::ToHex(to)).Set("data", web3::ToHex(data)));
  params.Append("latest");
  Send(endpoint,
       *base::WriteJson(base::DictValue()
                            .Set("jsonrpc", "2.0")
                            .Set("id", 1)
                            .Set("method", "eth_call")
                            .Set("params", std::move(params))),
       std::move(done));
}

void Rpc::GetCode(const GURL& endpoint, std::string_view address, Done done) {
  base::ListValue params;
  params.Append(web3::ToHex(address));
  params.Append("latest");
  Send(endpoint,
       *base::WriteJson(base::DictValue()
                            .Set("jsonrpc", "2.0")
                            .Set("id", 1)
                            .Set("method", "eth_getCode")
                            .Set("params", std::move(params))),
       std::move(done));
}

void Rpc::Send(const GURL& endpoint, std::string body, Done done) {
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = endpoint;
  request->method = "POST";
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->load_flags = net::LOAD_DISABLE_CACHE;
  done_ = std::move(done);
  loader_ = network::SimpleURLLoader::Create(std::move(request), kRpcAnnotation);
  loader_->SetOnRedirectCallback(
      base::BindRepeating(&Rpc::Redirected, base::Unretained(this)));
  loader_->AttachStringForUpload(std::move(body), "application/json");
  loader_->SetTimeoutDuration(kRpcTimeout);
  loader_->DownloadToString(
      factory_.get(),
      base::BindOnce(&Rpc::Loaded, base::Unretained(this)),
      network::SimpleURLLoader::kMaxBoundedStringDownloadSize);
}

void Rpc::Redirected(const GURL& from,
                     const net::RedirectInfo& redirect,
                     const network::mojom::URLResponseHead& head,
                     std::vector<std::string>* removed_headers) {
  if (UsableRpcUrl(redirect.new_url)) return;
  loader_.reset();
  std::move(done_).Run(Answer());
}

void Rpc::Loaded(std::optional<std::string> body) {
  Answer answer;
  std::optional<base::DictValue> reply =
      body ? base::JSONReader::ReadDict(*body, base::JSON_PARSE_RFC)
           : std::nullopt;
  if (reply) {
    if (const std::string* result = reply->FindString("result")) {
      if (std::optional<web3::Bytes> data = web3::FromHex(*result)) {
        answer.kind = Answer::Kind::kOk;
        answer.data = std::move(*data);
      }
    } else if (const base::DictValue* error = reply->FindDict("error")) {
      if (IsRevert(*error)) answer.kind = Answer::Kind::kReverted;
    }
  }
  std::move(done_).Run(std::move(answer));
}

const char* OutcomeName(Outcome outcome) {
  switch (outcome) {
    case Outcome::kOk: return "ok";
    case Outcome::kNoRpc: return "noRpc";
    case Outcome::kRpcFailed: return "rpcFailed";
    case Outcome::kReverted: return "reverted";
    case Outcome::kNotContract: return "notContract";
    case Outcome::kNotFound: return "notFound";
    case Outcome::kBadUrl: return "badUrl";
    case Outcome::kUnsupportedMode: return "unsupportedMode";
    case Outcome::kBadResponse: return "badResponse";
  }
  return "ok";
}

}

AC_ARGS_CALL(ac_web3_set_rpcs) {
  const base::DictValue* rpcs = call.args().FindDict("rpcs");
  if (!rpcs) return call.TakeReply().Error("rpcs must be an object");
  std::map<uint64_t, GURL> kept;
  base::ListValue refused;
  for (const auto [chain_text, value] : *rpcs) {
    uint64_t chain = 0;
    const std::string* text = value.GetIfString();
    GURL url(text ? *text : std::string());
    if (!base::StringToUint64(chain_text, &chain) || chain == 0 ||
        !ardia::web3_internal::UsableRpcUrl(url)) {
      refused.Append(chain_text);
      continue;
    }
    kept.emplace(chain, std::move(url));
  }
  ardia::web3_internal::Rpcs() = std::move(kept);
  ardia::web3_internal::ClearCaches();
  call.TakeReply().Send(base::DictValue().Set("refused", std::move(refused)));
}
