#include "ardia/win/webui/webui_telemetry.h"

#include <windows.h>

#include <algorithm>
#include <iterator>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/desktop/ac_desktop_telemetry_policy.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/base/url_util.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/fetch_api.mojom.h"
#include "url/gurl.h"

namespace ardia_win::webui {

namespace {

constexpr net::NetworkTrafficAnnotationTag kWinTelemetryTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_windows_usage_telemetry", R"(
      semantics {
        sender: "Ardia usage telemetry"
        description:
          "Sends anonymous usage telemetry from this Ardia build to the "
          "Ardia project: feature use counts, timings, enums and flags, "
          "batched as OpenTelemetry logs."
        trigger:
          "The browser's telemetry client flushing its queue of usage "
          "events, at most a few requests at a time."
        user_data {
          type: NONE
        }
        data:
          "Counts, timings, enums and flags tagged with an anonymous install "
          "id and the app version. No URLs, page content, titles or free "
          "text, and no cookies or credentials."
        destination: OTHER
        destination_other: "The Ardia telemetry collector at ardia.dev."
        last_reviewed: "2026-11-24"
      }
      policy {
        cookies_allowed: NO
        setting: "Settings > Privacy > Share anonymous crash reports and usage stats."
        policy_exception_justification: "Not implemented."
      })");

GURL TelemetryEndpoint() {
  if (ardiacore::TestInstance()) {
    wchar_t buffer[512] = {};
    const DWORD length = ::GetEnvironmentVariableW(
        L"ARDIA_TEST_TELEMETRY_ENDPOINT", buffer,
        static_cast<DWORD>(std::size(buffer)));
    if (length > 0 && length < std::size(buffer)) {
      const GURL loopback(base::WideToUTF8(std::wstring(buffer, length)));
      if (loopback.is_valid() && loopback.SchemeIs("http") &&
          net::IsLocalhost(loopback)) {
        return loopback;
      }
    }
  }
  return GURL(ardia::desktop_telemetry_policy::kEndpoint);
}

scoped_refptr<network::SharedURLLoaderFactory> TelemetryLoaderFactory() {
  if (!g_browser_process || g_browser_process->IsShuttingDown()) {
    return nullptr;
  }
  SystemNetworkContextManager* manager =
      g_browser_process->system_network_context_manager();
  return manager ? manager->GetSharedURLLoaderFactory() : nullptr;
}

}

int& TelemetryInFlight() {
  static int in_flight = 0;
  return in_flight;
}

int& TelemetryRequestsStarted() {
  static int started = 0;
  return started;
}

bool TelemetryPostAllowed(const std::string& body, const std::string& key) {
  if (!ardia::desktop_telemetry_policy::PostAcceptable(body, key)) {
    return false;
  }
  const std::optional<base::Value> parsed =
      base::JSONReader::Read(body, base::JSON_PARSE_RFC);
  return parsed && parsed->is_dict();
}

class WinTelemetryClient::TelemetryPost {
 public:
  TelemetryPost(WinTelemetryClient* owner, PostReply reply)
      : owner_(owner), reply_(std::move(reply)) {
    ++TelemetryInFlight();
  }
  TelemetryPost(const TelemetryPost&) = delete;
  TelemetryPost& operator=(const TelemetryPost&) = delete;
  ~TelemetryPost() { --TelemetryInFlight(); }

  void Load(network::mojom::URLLoaderFactory* factory,
            std::string body,
            const std::string& ingest_key) {
    namespace policy = ardia::desktop_telemetry_policy;
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = TelemetryEndpoint();
    request->method = "POST";
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->redirect_mode = network::mojom::RedirectMode::kError;
    request->load_flags = net::LOAD_DISABLE_CACHE;
    request->headers.SetHeader(net::HttpRequestHeaders::kContentType,
                               "application/json");
    request->headers.SetHeader("X-Ardia-Key", ingest_key);
    loader_ = network::SimpleURLLoader::Create(std::move(request),
                                               kWinTelemetryTrafficAnnotation);
    loader_->SetTimeoutDuration(base::Seconds(policy::kTimeoutSeconds));
    loader_->SetAllowHttpErrorResults(true);
    loader_->AttachStringForUpload(std::move(body), "application/json");
    ++TelemetryRequestsStarted();
    loader_->DownloadHeadersOnly(
        factory,
        base::BindOnce(&TelemetryPost::OnLoaded, base::Unretained(this)));
  }

  PostReply TakeReply() { return std::move(reply_); }

 private:
  void OnLoaded(scoped_refptr<net::HttpResponseHeaders> headers) {
    const int status = headers ? headers->response_code() : 0;
    owner_->Finish(this, ardia::desktop_telemetry_policy::ReportedStatus(
                             loader_->NetError() == net::OK, status));
  }

  raw_ptr<WinTelemetryClient> owner_;
  PostReply reply_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
};

WinTelemetryClient::WinTelemetryClient() = default;

WinTelemetryClient::~WinTelemetryClient() = default;

void WinTelemetryClient::CancelAll() {
  posts_.clear();
}

void WinTelemetryClient::Post(std::string body,
                              const std::string& ingest_key,
                              PostReply reply) {
  namespace policy = ardia::desktop_telemetry_policy;
  if (!TelemetryPostAllowed(body, ingest_key) ||
      !policy::AdmitPost(TelemetryInFlight())) {
    PostStatus(std::move(reply), 0);
    return;
  }
  scoped_refptr<network::SharedURLLoaderFactory> factory =
      TelemetryLoaderFactory();
  if (!factory) {
    PostStatus(std::move(reply), 0);
    return;
  }
  auto post = std::make_unique<TelemetryPost>(this, std::move(reply));
  TelemetryPost* started = post.get();
  posts_.push_back(std::move(post));
  started->Load(factory.get(), std::move(body), ingest_key);
}

void WinTelemetryClient::PostStatus(PostReply reply, int status) {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(reply), status));
}

void WinTelemetryClient::Finish(TelemetryPost* post, int status) {
  const auto found = std::find_if(
      posts_.begin(), posts_.end(),
      [post](const std::unique_ptr<TelemetryPost>& owned) {
        return owned.get() == post;
      });
  if (found == posts_.end()) {
    return;
  }
  std::unique_ptr<TelemetryPost> finished = std::move(*found);
  posts_.erase(found);
  PostStatus(finished->TakeReply(), status);
}

}
