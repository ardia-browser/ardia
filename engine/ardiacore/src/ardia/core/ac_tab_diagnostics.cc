// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/core/ac_tab_diagnostics.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <optional>
#include <string>
#include <utility>

#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_console_ring.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/devtools/devtools_availability_checker.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "net/base/net_errors.h"
#include "net/http/http_response_headers.h"
#include "services/network/public/cpp/request_destination.h"
#include "third_party/blink/public/common/loader/resource_type_util.h"
#include "third_party/blink/public/mojom/loader/resource_load_info.mojom.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardiacore {
namespace {

constexpr size_t kImportantConsoleCap = 150;
constexpr size_t kOtherConsoleCap = 50;
constexpr size_t kFailedNetworkCap = 100;
constexpr size_t kOtherNetworkCap = 150;
constexpr size_t kMessageUnits = 1000;
constexpr size_t kUrlBytes = 512;
constexpr size_t kMethodBytes = 16;
constexpr double kLargestSeq = 9007199254740991.0;

double SeqValue(uint64_t seq) {
  return static_cast<double>(seq);
}

uint64_t SeqArg(std::optional<double> value) {
  if (!value || !std::isfinite(*value) || *value <= 0) {
    return 0;
  }
  return static_cast<uint64_t>(std::min(std::floor(*value), kLargestSeq));
}

double Milliseconds(base::TimeDelta delta) {
  return std::max(0.0, std::round(delta.InMillisecondsF()));
}

std::string Clipped(const std::u16string& text, size_t units, bool* clipped) {
  *clipped = text.size() > units;
  if (!*clipped) {
    return base::UTF16ToUTF8(text);
  }
  size_t end = units;
  if (end > 0 && (text[end - 1] & 0xFC00) == 0xD800) {
    --end;
  }
  return base::UTF16ToUTF8(text.substr(0, end));
}

std::string Bytes(const std::string& text, size_t bytes) {
  std::string out;
  base::TruncateUTF8ToByteSize(text, bytes, &out);
  return out;
}

bool InPrimaryPage(content::RenderFrameHost* frame) {
  return frame && frame->GetOutermostMainFrame()->IsInPrimaryMainFrame();
}

bool Inspectable(content::RenderFrameHost* frame) {
  Profile* profile = Profile::FromBrowserContext(frame->GetBrowserContext());
  return !profile || IsInspectionAllowed(profile, frame);
}

bool Recordable(content::RenderFrameHost* frame) {
  return InPrimaryPage(frame) && Inspectable(frame);
}

const char* FrameName(content::RenderFrameHost* frame) {
  return frame && frame->GetParentOrOuterDocument() ? "sub" : "main";
}

const char* LevelName(blink::mojom::ConsoleMessageLevel level) {
  switch (level) {
    case blink::mojom::ConsoleMessageLevel::kVerbose:
      return "debug";
    case blink::mojom::ConsoleMessageLevel::kInfo:
      return "info";
    case blink::mojom::ConsoleMessageLevel::kWarning:
      return "warning";
    case blink::mojom::ConsoleMessageLevel::kError:
      return "error";
  }
  return "info";
}

std::string TypeName(network::mojom::RequestDestination destination) {
  std::string name = network::RequestDestinationToString(destination);
  return name.empty() ? "fetch" : name;
}

struct Entry {
  uint64_t seq;
  base::DictValue value;
};

class Ring {
 public:
  explicit Ring(size_t cap) : cap_(cap) {}

  void Push(uint64_t seq, base::DictValue value) {
    if (entries_.size() >= cap_) {
      entries_.pop_front();
    }
    entries_.push_back(Entry{seq, std::move(value)});
  }

  void DropBefore(uint64_t seq) {
    while (!entries_.empty() && entries_.front().seq < seq) {
      entries_.pop_front();
    }
  }

  const std::deque<Entry>& entries() const { return entries_; }

 private:
  size_t cap_;
  std::deque<Entry> entries_;
};

base::ListValue Merged(const Ring& first, const Ring& second, uint64_t since) {
  base::ListValue out;
  auto a = first.entries().begin();
  auto b = second.entries().begin();
  const auto a_end = first.entries().end();
  const auto b_end = second.entries().end();
  while (a != a_end || b != b_end) {
    const bool take_a = b == b_end || (a != a_end && a->seq < b->seq);
    const Entry& entry = take_a ? *a++ : *b++;
    if (entry.seq >= since) {
      out.Append(entry.value.Clone());
    }
  }
  return out;
}

class TabDiagnostics : public content::WebContentsObserver,
                       public content::WebContentsUserData<TabDiagnostics> {
 public:
  ~TabDiagnostics() override = default;

  base::DictValue Read(uint64_t since) const {
    base::DictValue out;
    out.Set("console", Merged(important_console_, other_console_, since));
    out.Set("network", Merged(failed_network_, other_network_, since));
    out.Set("nextSeq", SeqValue(next_seq_));
    out.Set("clearedBefore", SeqValue(cleared_before_));
    out.Set("capacity", base::DictValue()
                            .Set("console", static_cast<int>(kImportantConsoleCap +
                                                             kOtherConsoleCap))
                            .Set("network", static_cast<int>(kFailedNetworkCap +
                                                             kOtherNetworkCap)));
    return out;
  }

  void ClearBefore(uint64_t seq) {
    seq = std::min(seq, next_seq_);
    if (seq <= cleared_before_) {
      return;
    }
    cleared_before_ = seq;
    for (Ring* ring : {&important_console_, &other_console_, &failed_network_,
                       &other_network_}) {
      ring->DropBefore(seq);
    }
  }

 private:
  friend class content::WebContentsUserData<TabDiagnostics>;

  explicit TabDiagnostics(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<TabDiagnostics>(*contents) {}

  void OnDidAddMessageToConsole(
      content::RenderFrameHost* source_frame,
      blink::mojom::ConsoleMessageLevel log_level,
      const std::u16string& message,
      int32_t line_no,
      const std::u16string& source_id,
      const std::optional<std::u16string>& untrusted_stack_trace) override {
    if (!Recordable(source_frame)) {
      return;
    }
    bool clipped = false;
    base::DictValue entry;
    entry.Set("level", LevelName(log_level));
    entry.Set("message", Clipped(message, kMessageUnits, &clipped));
    entry.Set("source", DiagnosticsUrl(GURL(base::UTF16ToUTF8(source_id))));
    entry.Set("line", line_no);
    entry.Set("frame", FrameName(source_frame));
    if (clipped) {
      entry.Set("clipped", true);
    }
    const bool important =
        log_level == blink::mojom::ConsoleMessageLevel::kWarning ||
        log_level == blink::mojom::ConsoleMessageLevel::kError;
    Record(important ? important_console_ : other_console_, std::move(entry));
  }

  void ResourceLoadComplete(
      content::RenderFrameHost* render_frame_host,
      const content::GlobalRequestID& request_id,
      const GURL& original_url,
      const blink::mojom::ResourceLoadInfo& info) override {
    if (blink::IsRequestDestinationFrame(info.request_destination) ||
        !Recordable(render_frame_host)) {
      return;
    }
    base::DictValue entry;
    entry.Set("method", Bytes(info.method, kMethodBytes));
    entry.Set("url", DiagnosticsUrl(info.final_url));
    entry.Set("status", info.http_status_code);
    entry.Set("type", TypeName(info.request_destination));
    entry.Set("frame", FrameName(render_frame_host));
    if (info.was_cached) {
      entry.Set("cached", true);
    }
    if (!info.load_timing_info.request_start.is_null()) {
      entry.Set("durationMs", Milliseconds(base::TimeTicks::Now() -
                                           info.load_timing_info.request_start));
    }
    const bool failed = info.net_error != net::OK || info.http_status_code >= 400;
    if (info.net_error != net::OK) {
      entry.Set("error", net::ErrorToShortString(info.net_error));
    }
    if (failed) {
      entry.Set("failed", true);
    }
    Record(failed ? failed_network_ : other_network_, std::move(entry));
  }

  void DidFinishNavigation(content::NavigationHandle* handle) override {
    if (handle->IsSameDocument()) {
      return;
    }
    const bool main = handle->IsInMainFrame();
    content::RenderFrameHost* frame = handle->HasCommitted()
                                          ? handle->GetRenderFrameHost()
                                          : handle->GetParentFrameOrOuterDocument();
    if (main ? !handle->IsInPrimaryMainFrame() || (frame && !Inspectable(frame))
             : !Recordable(frame)) {
      return;
    }
    const GURL& url = handle->GetURL();
    if (!url.SchemeIsHTTPOrHTTPS() && !url.SchemeIsFile()) {
      return;
    }
    Profile* profile = Profile::FromBrowserContext(web_contents()->GetBrowserContext());
    if (profile && !IsInspectionAllowed(profile, url)) {
      return;
    }
    const net::Error error = handle->GetNetErrorCode();
    if (!handle->HasCommitted() &&
        (error == net::OK || error == net::ERR_ABORTED)) {
      return;
    }
    const net::HttpResponseHeaders* headers = handle->GetResponseHeaders();
    const int status = headers ? headers->response_code() : 0;
    base::DictValue entry;
    entry.Set("method", handle->IsPost() ? "POST" : "GET");
    entry.Set("url", DiagnosticsUrl(url));
    entry.Set("status", status);
    entry.Set("type", main ? "document" : "subdocument");
    entry.Set("frame", main ? "main" : "sub");
    entry.Set("durationMs",
              Milliseconds(base::TimeTicks::Now() - handle->NavigationStart()));
    const bool failed = error != net::OK || status >= 400;
    if (error != net::OK) {
      entry.Set("error", net::ErrorToShortString(error));
    }
    if (failed) {
      entry.Set("failed", true);
    }
    Record(failed ? failed_network_ : other_network_, std::move(entry));
  }

  void WasDiscarded() override { ClearBefore(next_seq_); }

  void Record(Ring& ring, base::DictValue entry) {
    const uint64_t seq = next_seq_++;
    entry.Set("seq", SeqValue(seq));
    entry.Set("time", base::Time::Now().InMillisecondsFSinceUnixEpoch());
    ring.Push(seq, std::move(entry));
  }

  uint64_t next_seq_ = 1;
  uint64_t cleared_before_ = 1;
  Ring important_console_{kImportantConsoleCap};
  Ring other_console_{kOtherConsoleCap};
  Ring failed_network_{kFailedNetworkCap};
  Ring other_network_{kOtherNetworkCap};

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(TabDiagnostics);

base::DictValue Refusal(const char* code, const char* reason) {
  return base::DictValue().Set("ok", false).Set("code", code).Set("reason", reason);
}

}

std::string DiagnosticsUrl(const GURL& url) {
  if (!url.is_valid()) {
    return std::string();
  }
  if (url.SchemeIsHTTPOrHTTPS() || url.SchemeIsWSOrWSS() || url.SchemeIsFile()) {
    GURL::Replacements strip;
    strip.ClearUsername();
    strip.ClearPassword();
    strip.ClearQuery();
    strip.ClearRef();
    return Bytes(url.ReplaceComponents(strip).spec(), kUrlBytes);
  }
  if (url.SchemeIsBlob() || url.SchemeIsFileSystem()) {
    const url::Origin origin = url::Origin::Create(url);
    return Bytes(std::string(url.scheme()) + ":" +
                     (origin.opaque() ? std::string() : origin.Serialize()),
                 kUrlBytes);
  }
  return Bytes(std::string(url.scheme()) + ":", kUrlBytes);
}

void WatchTabDiagnostics(content::WebContents* contents) {
  if (!contents || contents->GetBrowserContext()->IsOffTheRecord()) {
    return;
  }
  TabDiagnostics::CreateForWebContents(contents);
}

}

AC_ARGS_CALL(ac_tab_diagnostics) {
  ardia::Reply out = call.TakeReply();
  const base::DictValue& args = call.args();
  std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (!contents) {
    return out.Send(ardiacore::Refusal("no_page", "That tab has no page loaded."));
  }
  if (contents->GetBrowserContext()->IsOffTheRecord()) {
    return out.Send(ardiacore::Refusal("private", "Private tabs keep no diagnostics."));
  }
  if (!ardia::ContentsInspectable(contents)) {
    return out.Send(ardiacore::Refusal("not_inspectable", "DevTools can't inspect this tab, so it keeps no diagnostics."));
  }
  ardiacore::TabDiagnostics::CreateForWebContents(contents);
  ardiacore::TabDiagnostics* diagnostics =
      ardiacore::TabDiagnostics::FromWebContents(contents);
  if (std::optional<double> clear = args.FindDouble("clearBefore")) {
    diagnostics->ClearBefore(ardiacore::SeqArg(clear));
  }
  base::DictValue reply = diagnostics->Read(ardiacore::SeqArg(args.FindDouble("since")));
  reply.Set("ok", true);
  out.Send(std::move(reply));
}
