// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_page_signals.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <initializer_list>
#include <limits>
#include <optional>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/unguessable_token.h"
#include "chrome/browser/ardia/ac_cli_console_ring.h"
#include "chrome/browser/ardia/ac_cli_hit_probe.h"
#include "chrome/browser/devtools/devtools_availability_checker.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/document_user_data.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "services/network/public/cpp/is_potentially_trustworthy.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia {
namespace {

using Outcome = base::expected<base::DictValue, std::string>;

constexpr std::string_view kConsoleDelta = "Ardia.consoleDelta";
constexpr std::string_view kFocusedFrameOrigin = "Ardia.focusedFrameOrigin";
constexpr std::string_view kHitTest = "Ardia.hitTest";
constexpr double kMaxSeq = 9007199254740991.0;
constexpr size_t kMaxOriginParam = 2048;

struct SignalCounts {
  uint64_t console_reads = 0;
  uint64_t focused_origins = 0;
  uint64_t origin_mismatches = 0;
};

SignalCounts& Counts() {
  static SignalCounts counts;
  return counts;
}

int Clamped(uint64_t count) {
  return count > static_cast<uint64_t>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(count);
}

class DocumentIdentity : public content::DocumentUserData<DocumentIdentity> {
 public:
  ~DocumentIdentity() override = default;

  const base::UnguessableToken& token() const { return token_; }

 private:
  explicit DocumentIdentity(content::RenderFrameHost* frame)
      : content::DocumentUserData<DocumentIdentity>(frame),
        token_(base::UnguessableToken::Create()) {}
  friend class content::DocumentUserData<DocumentIdentity>;

  const base::UnguessableToken token_;
  DOCUMENT_USER_DATA_KEY_DECL();
};

DOCUMENT_USER_DATA_KEY_IMPL(DocumentIdentity);

bool FrameInspectable(content::RenderFrameHost* frame) {
  Profile* profile = Profile::FromBrowserContext(frame->GetBrowserContext());
  return !profile || IsInspectionAllowed(profile, frame);
}

void Answer(PageSignalReply reply, Outcome outcome) {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(reply), std::move(outcome)));
}

std::optional<std::string> UnknownParam(
    const base::DictValue& params,
    std::initializer_list<std::string_view> known) {
  for (auto [key, value] : params) {
    if (std::find(known.begin(), known.end(), key) == known.end()) {
      std::string shown;
      base::TruncateUTF8ToByteSize(key, 64, &shown);
      return base::StrCat({"ardia: unknown parameter ", shown});
    }
  }
  return std::nullopt;
}

std::optional<double> WholeNumber(const base::Value* value, double max) {
  if (!value || !(value->is_int() || value->is_double())) {
    return std::nullopt;
  }
  const double number = value->GetDouble();
  if (!std::isfinite(number) || number < 0 || number > max ||
      number != std::floor(number)) {
    return std::nullopt;
  }
  return number;
}

std::optional<double> Coordinate(const base::Value* value) {
  if (!value || !(value->is_int() || value->is_double())) {
    return std::nullopt;
  }
  const double number = value->GetDouble();
  if (!std::isfinite(number) || std::abs(number) > kMaxHitCoordinate) {
    return std::nullopt;
  }
  return number;
}

Outcome ReadConsole(const base::DictValue& params,
                    content::WebContents* contents) {
  if (std::optional<std::string> unknown =
          UnknownParam(params, {"after", "generation", "limit"})) {
    return base::unexpected(*unknown);
  }
  uint64_t after = 0;
  if (const base::Value* value = params.Find("after")) {
    std::optional<double> number = WholeNumber(value, kMaxSeq);
    if (!number) {
      return base::unexpected(
          "ardia: after must be a whole number from a previous next");
    }
    after = static_cast<uint64_t>(*number);
  }
  std::optional<double> generation;
  if (const base::Value* value = params.Find("generation")) {
    generation = WholeNumber(value, kMaxSeq);
    if (!generation) {
      return base::unexpected(
          "ardia: generation must be the generation of a previous reply");
    }
  }
  size_t limit = kConsoleDeltaMax;
  if (const base::Value* value = params.Find("limit")) {
    std::optional<double> number =
        WholeNumber(value, static_cast<double>(kConsoleDeltaMax));
    if (!number || *number < 1) {
      return base::unexpected(
          base::StrCat({"ardia: limit must be a whole number from 1 to ",
                        base::NumberToString(kConsoleDeltaMax)}));
    }
    limit = static_cast<size_t>(*number);
  }
  ++Counts().console_reads;
  return ConsoleDelta(contents, after, generation, limit);
}

Outcome ReadFocusedFrameOrigin(const base::DictValue& params,
                               content::WebContents* contents) {
  if (std::optional<std::string> unknown =
          UnknownParam(params, {"expectedOrigin"})) {
    return base::unexpected(*unknown);
  }
  std::optional<url::Origin> expected;
  if (const base::Value* value = params.Find("expectedOrigin")) {
    constexpr char kBadOrigin[] =
        "ardia: expectedOrigin must be an http or https origin such as "
        "https://example.com";
    if (!value->is_string() || value->GetString().empty() ||
        value->GetString().size() > kMaxOriginParam) {
      return base::unexpected(kBadOrigin);
    }
    const GURL url(value->GetString());
    const url::Origin origin = url::Origin::Create(url);
    if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS() || origin.opaque() ||
        origin.Serialize() != value->GetString()) {
      return base::unexpected(kBadOrigin);
    }
    expected = origin;
  }
  ++Counts().focused_origins;
  base::DictValue out;
  content::RenderFrameHost* frame = contents->GetFocusedFrame();
  if (!frame || !frame->IsRenderFrameLive()) {
    out.Set("focused", false);
    if (expected) {
      ++Counts().origin_mismatches;
      out.Set("matches", false);
    }
    return out;
  }
  if (!FrameInspectable(frame)) {
    return base::unexpected("ardia: DevTools can't inspect the focused frame");
  }
  const url::Origin& origin = frame->GetLastCommittedOrigin();
  out.Set("focused", true);
  out.Set("documentId", DocumentIdentity::GetOrCreateForCurrentDocument(frame)
                            ->token()
                            .ToString());
  out.Set("origin", origin.Serialize());
  out.Set("opaque", origin.opaque());
  out.Set("secure", network::IsOriginPotentiallyTrustworthy(origin));
  out.Set("frameId", frame->GetDevToolsFrameToken().ToString());
  out.Set("mainFrame", frame->IsInPrimaryMainFrame());
  if (origin.opaque()) {
    out.Set("precursorOrigin",
            origin.GetTupleOrPrecursorTupleIfOpaque().Serialize());
  }
  if (expected) {
    const bool matches = !origin.opaque() && origin.IsSameOriginWith(*expected);
    if (!matches) {
      ++Counts().origin_mismatches;
    }
    out.Set("matches", matches);
  }
  return out;
}

}

bool IsPageSignalMethod(std::string_view method) {
  return method == kConsoleDelta || method == kFocusedFrameOrigin ||
         method == kHitTest;
}

base::ScopedClosureRunner RunPageSignal(std::string_view method,
                                        const base::DictValue& params,
                                        content::WebContents* contents,
                                        PageSignalReply reply) {
  if (!contents || contents->IsBeingDestroyed()) {
    Answer(std::move(reply),
           base::unexpected("ardia: that target isn't a tab"));
    return base::ScopedClosureRunner();
  }
  if (!ContentsInspectable(contents)) {
    Answer(std::move(reply),
           base::unexpected("ardia: DevTools can't inspect this tab"));
    return base::ScopedClosureRunner();
  }
  if (method == kConsoleDelta) {
    Answer(std::move(reply), ReadConsole(params, contents));
    return base::ScopedClosureRunner();
  }
  if (method == kFocusedFrameOrigin) {
    Answer(std::move(reply), ReadFocusedFrameOrigin(params, contents));
    return base::ScopedClosureRunner();
  }
  if (method != kHitTest) {
    Answer(std::move(reply), base::unexpected("ardia: unknown Ardia method"));
    return base::ScopedClosureRunner();
  }
  if (std::optional<std::string> unknown =
          UnknownParam(params, {"x", "y", "backendNodeId"})) {
    Answer(std::move(reply), base::unexpected(*unknown));
    return base::ScopedClosureRunner();
  }
  std::optional<double> x = Coordinate(params.Find("x"));
  std::optional<double> y = Coordinate(params.Find("y"));
  if (!x || !y) {
    Answer(std::move(reply),
           base::unexpected("ardia: x and y must be numbers in CSS pixels "
                            "from the viewport's top left"));
    return base::ScopedClosureRunner();
  }
  std::optional<int> target;
  if (const base::Value* value = params.Find("backendNodeId")) {
    if (!value->is_int() || value->GetInt() <= 0) {
      Answer(
          std::move(reply),
          base::unexpected("ardia: backendNodeId must be a positive integer"));
      return base::ScopedClosureRunner();
    }
    target = value->GetInt();
  }
  return StartHitProbe(contents, *x, *y, target, std::move(reply));
}

base::DictValue PageSignalTotals() {
  const SignalCounts& counts = Counts();
  base::DictValue totals = HitProbeTotals();
  totals.Set("consoleReads", Clamped(counts.console_reads));
  totals.Set("focusedOrigins", Clamped(counts.focused_origins));
  totals.Set("originMismatches", Clamped(counts.origin_mismatches));
  return totals;
}

}
