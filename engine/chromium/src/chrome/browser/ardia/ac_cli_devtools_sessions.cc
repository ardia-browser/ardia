// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_devtools_sessions.h"

#include <array>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/ardia/ac_cli_cdp.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_cli_screenshot.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/gfx/geometry/size.h"

namespace ardia {
namespace {

constexpr char kTopic[] = "cliDevTools";
constexpr size_t kMaxSessions = 32;
constexpr size_t kMaxSessionsPerOwner = 8;
constexpr size_t kMaxSocketEventBytes = 900 * 1024;
constexpr size_t kMaxInspectEventBytes = 16 * 1024 * 1024;
constexpr int kMaxTimeoutMs = 120000;
constexpr size_t kMaxSocketScreenshotBytes = 960 * 1024;

constexpr std::array<std::string_view, 18> kInspectionMethods = {
    "Tracing.start",
    "Tracing.end",
    "Audits.enable",
    "Audits.disable",
    "DOM.enable",
    "DOM.disable",
    "DOM.getDocument",
    "DOM.querySelector",
    "CSS.enable",
    "CSS.disable",
    "CSS.getMatchedStylesForNode",
    "CSS.getComputedStyleForNode",
    "Debugger.enable",
    "Debugger.disable",
    "Debugger.setBreakpoint",
    "Debugger.setBreakpointByUrl",
    "Debugger.removeBreakpoint",
    "Page.reload",
};

bool IsInspectionMethod(std::string_view method) {
  for (std::string_view allowed : kInspectionMethods) {
    if (allowed == method) {
      return true;
    }
  }
  return false;
}

bool ReachesOtherTargets(std::string_view method,
                         const base::DictValue* params) {
  if (params && params->Find("browserContextId")) {
    return true;
  }
  if (method.starts_with("Target.")) {
    return method != "Target.setAutoAttach" &&
           method != "Target.detachFromTarget" &&
           method != "Target.getTargetInfo";
  }
  if (method.starts_with("Browser.")) {
    return method != "Browser.getVersion";
  }
  return method == "Storage.getCookies" || method == "Storage.setCookies" ||
         method == "Storage.clearCookies" ||
         method == "Network.getAllCookies" ||
         method == "Network.clearBrowserCookies" ||
         method == "Network.clearBrowserCache";
}

bool ValidMethodName(std::string_view method) {
  if (method.empty() || method.size() > 128) {
    return false;
  }
  for (char c : method) {
    if (!base::IsAsciiAlphaNumeric(c) && c != '.' && c != '_') {
      return false;
    }
  }
  return method.find('.') != std::string_view::npos;
}

class CliSession;

std::map<int, std::unique_ptr<CliSession>>& Sessions() {
  static base::NoDestructor<std::map<int, std::unique_ptr<CliSession>>>
      sessions;
  return *sessions;
}

void EndSession(int id, const std::string& reason);

class CliSession : public content::WebContentsObserver {
 public:
  CliSession(int id,
             std::string owner,
             bool full,
             content::WebContents* contents,
             std::unique_ptr<CdpSession> cdp)
      : content::WebContentsObserver(contents),
        id_(id),
        owner_(std::move(owner)),
        full_(full),
        cdp_(std::move(cdp)) {
    cdp_->SetEventSink(base::BindRepeating(&CliSession::Event,
                                           weak_factory_.GetWeakPtr()));
    cdp_->SetClosedCallback(base::BindOnce(
        [](int id, std::string reason) {
          base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
              FROM_HERE, base::BindOnce(&EndSession, id, reason));
        },
        id_));
    drawing_ = contents->IncrementCapturerCount(
        gfx::Size(), !full_, false, false);
    policy_ = std::make_unique<CliPolicyWatch>(
        contents, base::BindRepeating(&CliSession::PolicyChanged,
                                      weak_factory_.GetWeakPtr()));
  }

  void PolicyChanged() {
    if (CliTabRefusal(web_contents())) {
      base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&EndSession, id_, std::string("policy")));
    }
  }

  ~CliSession() override = default;

  const std::string& owner() const { return owner_; }
  bool full() const { return full_; }

  void Send(const std::string& method,
            base::DictValue params,
            const std::string& child,
            std::optional<base::TimeDelta> timeout,
            Reply out) {
    ++CliCounts().session_commands;
    content::WebContents* contents = web_contents();
    if (std::optional<std::string> refused = CliTabRefusal(contents)) {
      out.Error(*refused);
      return PolicyChanged();
    }
    if (method == "Page.captureScreenshot" && CliAnyFrameRefused(contents)) {
      return out.Error("a frame in this tab can't be captured");
    }
    if (method == "Page.captureScreenshot" && child.empty() && contents &&
        !TabDrawsOnScreen(contents)) {
      if (std::optional<ScreenshotOptions> options =
              ScreenshotOptionsFromCdp(params)) {
        options->owner = owner_;
        options->max_encoded_bytes =
            full_ ? kMaxSocketScreenshotBytes : options->max_encoded_bytes;
        CaptureTabScreenshot(
            contents, std::move(*options),
            base::BindOnce(&CliSession::Captured, weak_factory_.GetWeakPtr(),
                           method, std::move(params), child, timeout,
                           std::move(out)));
        return;
      }
    }
    Forward(method, std::move(params), child, timeout, std::move(out));
  }

  void WebContentsDestroyed() override {
    Observe(nullptr);
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&EndSession, id_, std::string("tab-closed")));
  }

 private:
  void Forward(const std::string& method,
               base::DictValue params,
               const std::string& child,
               std::optional<base::TimeDelta> timeout,
               Reply out) {
    cdp_->Send(method, std::move(params),
               base::BindOnce(&CliSession::Replied, weak_factory_.GetWeakPtr(),
                              method == "Page.captureScreenshot",
                              std::move(out)),
               child, timeout);
  }

  static void Replied(base::WeakPtr<CliSession> self,
                      bool screenshot,
                      Reply out,
                      CdpResult result) {
    if (!result.has_value()) {
      return out.Error(result.error());
    }
    if (screenshot) {
      content::WebContents* contents = self ? self->web_contents() : nullptr;
      if (!contents) {
        return out.Error("the session ended");
      }
      if (std::optional<std::string> refused = CliTabRefusal(contents)) {
        out.Error(*refused);
        return self->PolicyChanged();
      }
      if (CliAnyFrameRefused(contents)) {
        return out.Error("a frame in this tab can't be captured");
      }
    }
    out.Send(base::DictValue().Set("result", std::move(result.value())));
  }

  void Captured(std::string method,
                base::DictValue params,
                std::string child,
                std::optional<base::TimeDelta> timeout,
                Reply out,
                base::expected<base::DictValue, std::string> shot) {
    if (!shot.has_value() && shot.error() == kScreenshotTooBig) {
      return out.Error(shot.error());
    }
    if (shot.has_value()) {
      std::string* data = shot->FindString("data");
      if (data) {
        out.Send(base::DictValue()
                     .Set("result", base::DictValue().Set("data",
                                                          std::move(*data)))
                     .Set("offscreen", true));
        return;
      }
    }
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      out.Error(*refused);
      return PolicyChanged();
    }
    if (CliAnyFrameRefused(web_contents())) {
      return out.Error("a frame in this tab can't be captured");
    }
    Forward(method, std::move(params), child, timeout, std::move(out));
  }

  void Event(const std::string& method,
             base::DictValue params,
             const std::string& child,
             size_t bytes) {
    ++CliCounts().session_events;
    base::DictValue payload;
    payload.Set("session", id_);
    payload.Set("method", method);
    if (!child.empty()) {
      payload.Set("sessionId", child);
    }
    if (const uint64_t dropped = cdp_->TakeDroppedEvents()) {
      CliCounts().session_events_cut += dropped;
      payload.Set("dropped", static_cast<double>(dropped));
    }
    if (bytes > (full_ ? kMaxSocketEventBytes : kMaxInspectEventBytes)) {
      ++CliCounts().session_events_cut;
      payload.Set("cut", true);
      payload.Set("bytes", static_cast<double>(bytes));
    } else {
      payload.Set("params", std::move(params));
    }
    Emit(kTopic, nullptr, std::move(payload));
  }

  int id_;
  std::string owner_;
  bool full_;
  std::unique_ptr<CdpSession> cdp_;
  base::ScopedClosureRunner drawing_;
  std::unique_ptr<CliPolicyWatch> policy_;
  base::WeakPtrFactory<CliSession> weak_factory_{this};
};

void EndSession(int id, const std::string& reason) {
  auto it = Sessions().find(id);
  if (it == Sessions().end()) {
    return;
  }
  std::unique_ptr<CliSession> session = std::move(it->second);
  Sessions().erase(it);
  session.reset();
  Emit(kTopic, nullptr,
       base::DictValue().Set("session", id).Set("closed", reason));
}

CliSession* SessionFor(const base::DictValue& args,
                       const std::string& owner,
                       std::string* error) {
  std::optional<int> id = args.FindInt("session");
  auto it = id ? Sessions().find(*id) : Sessions().end();
  if (it == Sessions().end() || it->second->owner() != owner) {
    *error = "no such DevTools session";
    return nullptr;
  }
  return it->second.get();
}

}

size_t LiveCliDevToolsSessions() {
  return Sessions().size();
}

int CloseCliDevToolsSessionsOf(std::string_view owner) {
  std::vector<int> ids;
  for (const auto& [id, session] : Sessions()) {
    if (session->owner() == owner) {
      ids.push_back(id);
    }
  }
  for (int id : ids) {
    EndSession(id, "owner-closed");
  }
  return static_cast<int>(ids.size());
}

void CloseAllCliDevToolsSessions() {
  std::vector<int> ids;
  for (const auto& [id, session] : Sessions()) {
    ids.push_back(id);
  }
  for (int id : ids) {
    EndSession(id, "control-off");
  }
}

}

AC_ARGS_CALL(ac_cli_devtools_open) {
  ardia::Reply out = call.TakeReply();
  const std::string owner = call.String("owner");
  if (!ardia::ValidCliOwner(owner)) {
    return out.Error("bad owner");
  }
  std::optional<int> tab = call.args().FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (!contents || contents->IsBeingDestroyed()) {
    return out.Error("no such tab");
  }
  const std::string scope = call.String("scope");
  if (scope != "full" && scope != "inspect") {
    return out.Error("scope must be full or inspect");
  }
  const bool full = scope == "full";
  if (std::optional<std::string> refused = ardia::CliTabRefusal(contents)) {
    ++ardia::CliCounts().sessions_refused;
    return out.Error(*refused);
  }
  size_t owned = 0;
  for (const auto& [id, session] : ardia::Sessions()) {
    if (session->owner() == owner) {
      ++owned;
    }
  }
  if (ardia::Sessions().size() >= ardia::kMaxSessions ||
      owned >= ardia::kMaxSessionsPerOwner) {
    ++ardia::CliCounts().sessions_refused;
    return out.Error("too many DevTools sessions are open");
  }
  std::string error;
  std::unique_ptr<ardia::CdpSession> cdp = ardia::CdpSession::Attach(
      contents,
      ardia::CdpAccess{.local_files = full,
                       .max_event_bytes = full ? ardia::kMaxSocketEventBytes
                                               : ardia::kMaxInspectEventBytes,
                       .max_reply_bytes = full ? ardia::kMaxSocketEventBytes
                                               : ardia::kMaxInspectEventBytes},
      &error);
  if (!cdp) {
    ++ardia::CliCounts().sessions_refused;
    return out.Error(error);
  }
  static int last = 0;
  const int id = ++last;
  ardia::Sessions().emplace(
      id, std::make_unique<ardia::CliSession>(id, owner, full, contents,
                                              std::move(cdp)));
  ++ardia::CliCounts().sessions_opened;
  out.Send(base::DictValue()
               .Set("session", id)
               .Set("targetId",
                    content::DevToolsAgentHost::GetOrCreateFor(contents)
                        ->GetId())
               .Set("scope", scope));
}

AC_ARGS_CALL(ac_cli_devtools_send) {
  ardia::Reply out = call.TakeReply();
  const std::string owner = call.String("owner");
  std::string error;
  ardia::CliSession* session =
      ardia::ValidCliOwner(owner)
          ? ardia::SessionFor(call.args(), owner, &error)
          : nullptr;
  if (!session) {
    return out.Error(error.empty() ? "bad owner" : error);
  }
  if (!ardia::CliRemoteDebuggingAllowed()) {
    ardia::EndSession(*call.args().FindInt("session"), "policy");
    return out.Error("DevTools is turned off for this tab by your administrator");
  }
  const std::string method = call.String("method");
  if (!ardia::ValidMethodName(method)) {
    return out.Error("bad method");
  }
  if (!session->full() && !ardia::IsInspectionMethod(method)) {
    return out.Error("an inspection session never sends " + method);
  }
  const base::Value* params = call.args().Find("params");
  if (params && !params->is_dict()) {
    return out.Error("params must be an object");
  }
  if (ardia::ReachesOtherTargets(
          method, params && params->is_dict() ? &params->GetDict() : nullptr) ||
      (method == "Target.getTargetInfo" && params && params->is_dict() &&
       params->GetDict().Find("targetId"))) {
    return out.Error(
        "a tab's DevTools session reaches only its own tab; open tabs with "
        "apply");
  }
  const std::string child = call.String("sessionId");
  if (child.size() > 128 || (!child.empty() && !session->full())) {
    return out.Error("bad sessionId");
  }
  std::optional<base::TimeDelta> timeout = ardia::kCdpStepDeadline;
  if (std::optional<int> ms = call.args().FindInt("timeoutMs")) {
    if (*ms < 1 || *ms > ardia::kMaxTimeoutMs) {
      return out.Error("timeoutMs must be 1 to 120000");
    }
    timeout = base::Milliseconds(*ms);
  }
  session->Send(method, params ? params->GetDict().Clone() : base::DictValue(),
                child, timeout, std::move(out));
}

AC_ARGS_CALL(ac_cli_devtools_close) {
  ardia::Reply out = call.TakeReply();
  const std::string owner = call.String("owner");
  if (!ardia::ValidCliOwner(owner)) {
    return out.Error("bad owner");
  }
  std::string error;
  if (!ardia::SessionFor(call.args(), owner, &error)) {
    return out.Send(base::DictValue().Set("closed", false));
  }
  ardia::EndSession(*call.args().FindInt("session"), "detached");
  out.Send(base::DictValue().Set("closed", true));
}
