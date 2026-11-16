// Copyright 2026 Ardia. Apache-2.0.

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/escape.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "chrome/browser/ardia/ac_web3_internal.h"
#include "net/base/mime_sniffer.h"
#include "net/base/mime_util.h"
#include "net/http/http_util.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "third_party/icu/source/common/unicode/uidna.h"
#include "third_party/zlib/google/compression_utils.h"

namespace ardia::web3_internal {
namespace {

constexpr base::TimeDelta kCacheLifetime = base::Minutes(5);
constexpr size_t kMaxCacheEntries = 512;
constexpr size_t kMaxBodyBytes = 32u << 20;
constexpr char kRegistry[] = "0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e";
constexpr char kPublicNodeRpc[] = "https://ethereum-rpc.publicnode.com";

constexpr const char* kKeptHeaders[] = {
    "content-type",
    "content-language",
    "content-security-policy",
    "cross-origin-embedder-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "permissions-policy",
    "referrer-policy",
    "x-content-type-options",
    "x-frame-options",
};

struct Target {
  uint64_t chain = 1;
  web3::Bytes address;
};

template <typename Value>
struct Cache {
  struct Entry {
    base::TimeTicks until;
    Value value;
  };
  std::map<std::string, Entry> entries;

  std::optional<Value> Get(const std::string& key) {
    auto it = entries.find(key);
    if (it == entries.end()) return std::nullopt;
    if (it->second.until < base::TimeTicks::Now()) {
      entries.erase(it);
      return std::nullopt;
    }
    return it->second.value;
  }

  void Put(const std::string& key, Value value) {
    if (entries.size() >= kMaxCacheEntries) entries.clear();
    entries[key] = Entry{base::TimeTicks::Now() + kCacheLifetime, std::move(value)};
  }
};

Cache<Target>& Names() {
  static base::NoDestructor<Cache<Target>> names;
  return *names;
}

Cache<web3::Mode>& Modes() {
  static base::NoDestructor<Cache<web3::Mode>> modes;
  return *modes;
}

std::string CacheKey(uint64_t chain, std::string_view what) {
  return base::NumberToString(chain) + ":" + std::string(what);
}

bool IsZero(std::string_view bytes) {
  return bytes.find_first_not_of('\0') == std::string_view::npos;
}

std::optional<web3::Bytes> AddressWord(const web3::Bytes& returned) {
  if (returned.size() < 32) return std::nullopt;
  return returned.substr(12, 20);
}

web3::Bytes NameCall(std::string_view signature, const web3::Bytes& node) {
  return web3::Selector(signature) + node;
}

web3::Bytes TextCall(const web3::Bytes& node, std::string_view key) {
  static const web3::AbiType type = *web3::ParseAbiType("(bytes32,string)");
  return web3::Selector("text(bytes32,string)") +
         web3::AbiEncode(type, {web3::AbiWord(node), web3::AbiBytes(std::string(key))});
}

std::string Escaped(std::string_view text) {
  return base::EscapeForHTML(text);
}

void Sniff(Page& page, const GURL& url) {
  std::string mime;
  net::SniffMimeType(page.body, url, "", net::ForceSniffFileUrlsForHtml::kDisabled, &mime);
  page.mime_type = mime.empty() ? "text/plain" : mime;
}

std::string UnicodeName(const std::string& host) {
  if (host.find("xn--") == std::string::npos) return host;
  UErrorCode status = U_ZERO_ERROR;
  UIDNA* idna = uidna_openUTS46(UIDNA_NONTRANSITIONAL_TO_UNICODE, &status);
  if (U_FAILURE(status)) return host;
  std::string unicode(host.size() * 4, '\0');
  UIDNAInfo info = UIDNA_INFO_INITIALIZER;
  const int32_t length = uidna_nameToUnicodeUTF8(
      idna, host.data(), static_cast<int32_t>(host.size()), unicode.data(),
      static_cast<int32_t>(unicode.size()), &info, &status);
  uidna_close(idna);
  if (U_FAILURE(status) || info.errors != 0) return host;
  unicode.resize(length);
  return unicode;
}

bool KeptHeader(const std::string& name) {
  const std::string lower = base::ToLowerASCII(name);
  for (const char* kept : kKeptHeaders) {
    if (lower == kept) return true;
  }
  return false;
}

}

void ClearCaches() {
  Names().entries.clear();
  Modes().entries.clear();
}

Page ErrorPage(int status,
               std::string_view title,
               std::string_view detail,
               std::optional<uint64_t> settings_chain) {
  Page page;
  page.status = status;
  page.mime_type = "text/html";
  page.charset = "utf-8";
  page.headers.emplace_back("Content-Security-Policy",
                            "default-src 'none'; style-src 'unsafe-inline'");
  std::string actions;
  if (settings_chain) {
    actions = "<p><a class=button href=\"ardia://settings/web3\">Open web3:// Settings</a></p>";
    if (*settings_chain == 1) {
      actions += std::string("<p class=hint>Settings has a one-click option to use ") +
                 kPublicNodeRpc + ", a public RPC. It sees which contracts you open.</p>";
    }
  }
  page.body = "<!doctype html><meta charset=utf-8><meta name=color-scheme "
              "content=\"light dark\"><title>" +
              Escaped(title) +
              "</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;"
              "max-width:560px;margin:15vh auto;padding:0 24px}h1{font-size:22px;"
              "font-weight:600}p{color:GrayText}.button{display:inline-block;"
              "padding:6px 14px;border-radius:8px;background:AccentColor;"
              "color:AccentColorText;text-decoration:none}.hint{font-size:13px}"
              "</style><h1>" +
              Escaped(title) + "</h1><p>" + Escaped(detail) + "</p>" + actions;
  return page;
}

Resolver::Resolver(scoped_refptr<network::SharedURLLoaderFactory> factory,
                   GURL url,
                   Done done)
    : rpc_(std::move(factory)), url_(std::move(url)), done_(std::move(done)) {}

Resolver::~Resolver() = default;

void Resolver::Start() {
  std::optional<web3::Host> host = web3::ParseHost(url_.host());
  if (!host) {
    return Fail(Outcome::kBadUrl, 400, "Not a web3:// address",
                "web3:// opens a contract address (0x…) or an ENS name (….eth).");
  }
  if (url_.has_port()) {
    unsigned chain = 0;
    if (!base::StringToUint(url_.port(), &chain) || chain == 0) {
      return Fail(Outcome::kBadUrl, 400, "Not a web3:// address",
                  "The chain ID after the colon must be a number above 0.");
    }
    chain_ = chain;
  }
  if (host->address) {
    address_ = std::move(*host->address);
    return ResolveMode();
  }
  name_ = UnicodeName(host->name);
  if (std::optional<Target> cached = Names().Get(CacheKey(chain_, name_))) {
    chain_ = cached->chain;
    address_ = std::move(cached->address);
    return ResolveMode();
  }
  ResolveName();
}

bool Resolver::EnsureRpc(uint64_t chain) {
  std::optional<GURL> endpoint = RpcFor(chain);
  if (!endpoint) {
    Fail(Outcome::kNoRpc, 503,
         "web3:// needs an RPC for chain " + base::NumberToString(chain),
         "Ardia reads web3:// pages straight from the chain, through an RPC "
         "you choose. Add one for chain " +
             base::NumberToString(chain) + " in Settings, then reload.");
    return false;
  }
  endpoint_ = std::move(*endpoint);
  return true;
}

void Resolver::ResolveName() {
  if (!EnsureRpc(chain_)) return;
  node_ = web3::NameHash(name_);
  rpc_.Call(endpoint_, *web3::FromHex(kRegistry), NameCall("resolver(bytes32)", node_),
            base::BindOnce(&Resolver::GotResolver, base::Unretained(this)));
}

void Resolver::GotResolver(Rpc::Answer answer) {
  if (answer.kind == Rpc::Answer::Kind::kFailed) {
    return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                "Ardia couldn't resolve " + name_ + " through the RPC for chain " +
                    base::NumberToString(chain_) + ".");
  }
  std::optional<web3::Bytes> resolver = AddressWord(answer.data);
  if (answer.kind != Rpc::Answer::Kind::kOk || !resolver || IsZero(*resolver)) {
    return Fail(Outcome::kNotFound, 404, name_ + " isn't registered",
                "ENS has no resolver for this name on chain " +
                    base::NumberToString(chain_) + ".");
  }
  name_resolver_ = std::move(*resolver);
  rpc_.Call(endpoint_, name_resolver_, TextCall(node_, "contentcontract"),
            base::BindOnce(&Resolver::GotContentContract, base::Unretained(this)));
}

void Resolver::GotContentContract(Rpc::Answer answer) {
  if (answer.kind == Rpc::Answer::Kind::kFailed) {
    return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                "Ardia couldn't read " + name_ + "'s records.");
  }
  static const web3::AbiType type = *web3::ParseAbiType("(string)");
  std::optional<std::vector<web3::AbiValue>> record =
      answer.kind == Rpc::Answer::Kind::kOk ? web3::AbiDecode(type, answer.data)
                                            : std::nullopt;
  if (!record || (*record)[0].data.empty()) {
    return rpc_.Call(endpoint_, name_resolver_, NameCall("addr(bytes32)", node_),
                     base::BindOnce(&Resolver::GotAddress, base::Unretained(this)));
  }
  std::optional<web3::ContentContract> contract =
      web3::ParseContentContract((*record)[0].data);
  if (!contract) {
    return Fail(Outcome::kNotFound, 404, name_ + " has an unknown contentcontract",
                "Its contentcontract record isn't an address Ardia can open: " +
                    (*record)[0].data);
  }
  const std::string key = CacheKey(chain_, name_);
  chain_ = contract->chain_id.value_or(chain_);
  address_ = std::move(contract->address);
  Names().Put(key, Target{chain_, address_});
  ResolveMode();
}

void Resolver::GotAddress(Rpc::Answer answer) {
  if (answer.kind == Rpc::Answer::Kind::kFailed) {
    return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                "Ardia couldn't read " + name_ + "'s address.");
  }
  std::optional<web3::Bytes> address = AddressWord(answer.data);
  if (answer.kind != Rpc::Answer::Kind::kOk || !address || IsZero(*address)) {
    return Fail(Outcome::kNotFound, 404, name_ + " has no address",
                "The name has no contentcontract record and no address.");
  }
  address_ = std::move(*address);
  Names().Put(CacheKey(chain_, name_), Target{chain_, address_});
  ResolveMode();
}

void Resolver::ResolveMode() {
  if (!EnsureRpc(chain_)) return;
  if (std::optional<web3::Mode> mode = Modes().Get(CacheKey(chain_, address_))) {
    mode_ = *mode;
    return Request();
  }
  rpc_.Call(endpoint_, address_, web3::Selector("resolveMode()"),
            base::BindOnce(&Resolver::GotMode, base::Unretained(this)));
}

void Resolver::GotMode(Rpc::Answer answer) {
  switch (answer.kind) {
    case Rpc::Answer::Kind::kFailed:
      return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                  "Ardia couldn't reach the RPC for chain " +
                      base::NumberToString(chain_) + ".");
    case Rpc::Answer::Kind::kReverted:
      mode_ = web3::Mode::kAuto;
      break;
    case Rpc::Answer::Kind::kOk:
      if (answer.data.empty()) {
        return rpc_.GetCode(endpoint_, address_,
                            base::BindOnce(&Resolver::GotCode, base::Unretained(this)));
      }
      mode_ = web3::ModeFromResolveMode(answer.data);
      break;
  }
  Modes().Put(CacheKey(chain_, address_), mode_);
  Request();
}

void Resolver::GotCode(Rpc::Answer answer) {
  if (answer.kind != Rpc::Answer::Kind::kOk) {
    return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                "Ardia couldn't reach the RPC for chain " +
                    base::NumberToString(chain_) + ".");
  }
  if (answer.data.empty()) {
    return Fail(Outcome::kNotContract, 404, "Not a contract",
                web3::ToHex(address_) + " on chain " + base::NumberToString(chain_) +
                    " has no code, so it can't serve a page.");
  }
  mode_ = web3::Mode::kAuto;
  Modes().Put(CacheKey(chain_, address_), mode_);
  Request();
}

void Resolver::Request() {
  switch (mode_) {
    case web3::Mode::kResource: {
      std::optional<web3::Bytes> call =
          web3::ResourceRequestCall(url_.path(), url_.query());
      if (!call) {
        return Fail(Outcome::kBadUrl, 400, "Not a web3:// call",
                    "The address has too many path segments or query parameters.");
      }
      return rpc_.Call(endpoint_, address_, *call,
                       base::BindOnce(&Resolver::GotResource, base::Unretained(this)));
    }
    case web3::Mode::kAuto: {
      std::variant<web3::AutoCall, std::string> call =
          web3::ParseAutoCall(url_.path(), url_.query());
      if (std::string* error = std::get_if<std::string>(&call)) {
        return Fail(Outcome::kBadUrl, 400, "Not a web3:// call", *error);
      }
      auto_call_ = std::move(std::get<web3::AutoCall>(call));
      return rpc_.Call(endpoint_, address_, auto_call_.calldata,
                       base::BindOnce(&Resolver::GotAuto, base::Unretained(this)));
    }
    case web3::Mode::kManual:
    case web3::Mode::kUnsupported:
      return Fail(Outcome::kUnsupportedMode, 501, "This contract uses another resolve mode",
                  "Ardia opens contracts in auto and ERC-5219 mode. Manual mode isn't "
                  "supported yet.");
  }
}

void Resolver::GotResource(Rpc::Answer answer) {
  if (answer.kind == Rpc::Answer::Kind::kFailed) {
    return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                "The page's call didn't come back from the RPC.");
  }
  if (answer.kind == Rpc::Answer::Kind::kReverted) {
    return Fail(Outcome::kReverted, 500, "The contract reverted",
                "The contract refused this request.");
  }
  std::optional<web3::Resource> resource = web3::DecodeResource(answer.data);
  if (!resource) {
    return Fail(Outcome::kBadResponse, 502, "Not an ERC-5219 response",
                "The contract's answer isn't a status, body and headers.");
  }
  Page page;
  page.status = resource->status;
  page.body = std::move(resource->body);
  for (auto& [name, value] : resource->headers) {
    if (!net::HttpUtil::IsValidHeaderName(name) ||
        !net::HttpUtil::IsValidHeaderValue(value)) {
      continue;
    }
    const std::string lower = base::ToLowerASCII(name);
    if (lower == "content-encoding") {
      const std::string encoding =
          base::ToLowerASCII(base::TrimWhitespaceASCII(value, base::TRIM_ALL));
      if (encoding == "identity") continue;
      const uint32_t size =
          encoding == "gzip" ? compression::GetUncompressedSize(base::as_byte_span(page.body)) : 0;
      std::string decoded;
      if (encoding == "gzip" && size <= kMaxBodyBytes) {
        decoded.resize(size);
      }
      if (decoded.size() != size || size == 0 ||
          !compression::GzipUncompress(base::as_byte_span(page.body),
                                       base::as_writable_byte_span(decoded))) {
        return Fail(Outcome::kBadResponse, 502, "Can't decode the page",
                    "The contract sent a body in an encoding Ardia can't read: " +
                        encoding);
      }
      page.body = std::move(decoded);
      continue;
    }
    if (lower == "content-type") {
      bool had_charset = false;
      net::HttpUtil::ParseContentType(value, &page.mime_type, &page.charset,
                                      &had_charset, nullptr);
    }
    if (lower == "content-security-policy") {
      value = web3::WithoutCspReporting(value);
      if (value.empty()) continue;
    }
    if (KeptHeader(lower)) page.headers.emplace_back(std::move(name), std::move(value));
  }
  if (page.mime_type.empty()) Sniff(page, url_);
  Finish(Result{std::move(page), Outcome::kOk, "5219"});
}

void Resolver::GotAuto(Rpc::Answer answer) {
  if (answer.kind == Rpc::Answer::Kind::kFailed) {
    return Fail(Outcome::kRpcFailed, 502, "The RPC didn't answer",
                "The page's call didn't come back from the RPC.");
  }
  if (answer.kind == Rpc::Answer::Kind::kReverted) {
    return Fail(Outcome::kReverted, 500, "The contract reverted",
                "The contract refused this call.");
  }
  std::optional<web3::AutoBody> body = web3::AutoCallBody(auto_call_, answer.data);
  if (!body) {
    return Fail(Outcome::kBadResponse, 502, "Can't read the contract's answer",
                "The answer doesn't decode as the types the URL asks for.");
  }
  Page page;
  page.body = std::move(body->body);
  if (body->json) {
    page.mime_type = "application/json";
  } else if (!auto_call_.extension.empty()) {
    net::GetWellKnownMimeTypeFromExtension(auto_call_.extension, &page.mime_type);
  }
  if (page.mime_type.empty()) Sniff(page, url_);
  Finish(Result{std::move(page), Outcome::kOk, "auto"});
}

void Resolver::Fail(Outcome outcome,
                    int status,
                    std::string title,
                    std::string detail) {
  std::optional<uint64_t> settings_chain;
  if (outcome == Outcome::kNoRpc || outcome == Outcome::kRpcFailed) {
    settings_chain = chain_;
  }
  Finish(Result{ErrorPage(status, title, detail, settings_chain), outcome,
                mode_ == web3::Mode::kResource ? "5219" : "auto"});
}

void Resolver::Finish(Result result) {
  std::move(done_).Run(std::move(result));
}

}
