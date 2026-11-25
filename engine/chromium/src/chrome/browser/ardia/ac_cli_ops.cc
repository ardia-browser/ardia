// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_ops.h"

#include <limits>
#include <map>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "components/policy/core/browser/url_list/url_list_policy_pref_names.h"
#include "chrome/browser/ardia/ac_cli_devtools_sessions.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/devtools/devtools_availability_checker.h"
#include "chrome/browser/policy/developer_tools_policy_checker.h"
#include "chrome/browser/policy/developer_tools_policy_checker_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ardia {
namespace {

struct Op {
  std::string owner;
  base::OnceClosure cancel;
};

std::map<int, Op>& Ops() {
  static base::NoDestructor<std::map<int, Op>> ops;
  return *ops;
}

int Clamped(uint64_t count) {
  return count > static_cast<uint64_t>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(count);
}

}

EngineCliCounts& CliCounts() {
  static EngineCliCounts counts;
  return counts;
}

base::DictValue EngineCliTotals() {
  const EngineCliCounts& c = CliCounts();
  return base::DictValue()
      .Set("sessionsOpened", Clamped(c.sessions_opened))
      .Set("sessionsRefused", Clamped(c.sessions_refused))
      .Set("sessionCommands", Clamped(c.session_commands))
      .Set("sessionEvents", Clamped(c.session_events))
      .Set("sessionEventsCut", Clamped(c.session_events_cut))
      .Set("snapshots", Clamped(c.snapshots))
      .Set("snapshotsFailed", Clamped(c.snapshots_failed))
      .Set("snapshotRefs", Clamped(c.snapshot_refs))
      .Set("snapshotsModal", Clamped(c.snapshots_modal))
      .Set("occludedRefs", Clamped(c.occluded_refs))
      .Set("settles", Clamped(c.settles))
      .Set("settlesTimedOut", Clamped(c.settles_timed_out))
      .Set("settleMs", Clamped(c.settle_ms))
      .Set("hitTests", Clamped(c.hit_tests))
      .Set("clicks", Clamped(c.clicks))
      .Set("clicksBlocked", Clamped(c.clicks_blocked))
      .Set("dismissFound", Clamped(c.dismiss_found))
      .Set("refsRebound", Clamped(c.refs_rebound))
      .Set("refsStale", Clamped(c.refs_stale))
      .Set("screenshots", Clamped(c.screenshots))
      .Set("screenshotsHidden", Clamped(c.screenshots_hidden))
      .Set("screenshotsFailed", Clamped(c.screenshots_failed))
      .Set("cancelled", Clamped(c.cancelled))
      .Set("clicksUnverified", Clamped(c.clicks_unverified))
      .Set("refused", Clamped(c.refused))
      .Set("liveSessions", static_cast<int>(LiveCliDevToolsSessions()));
}

int CancelAllCliOps() {
  std::map<int, Op> ops = std::move(Ops());
  Ops().clear();
  for (auto& [id, op] : ops) {
    ++CliCounts().cancelled;
    std::move(op.cancel).Run();
  }
  const int sessions = static_cast<int>(LiveCliDevToolsSessions());
  CloseAllCliDevToolsSessions();
  return static_cast<int>(ops.size()) + sessions;
}

bool CliRemoteDebuggingAllowed() {
  PrefService* local_state =
      g_browser_process ? g_browser_process->local_state() : nullptr;
  return local_state &&
         local_state->GetBoolean(prefs::kDevToolsRemoteDebuggingAllowed);
}

bool CliRefusedUrl(const GURL& url) {
  return url.SchemeIs("chrome") || url.SchemeIs("chrome-untrusted") ||
         url.SchemeIs("devtools") || url.SchemeIs("chrome-search");
}

bool CliFrameRefused(content::RenderFrameHost* frame) {
  if (!frame || frame->GetBrowserContext()->IsOffTheRecord() ||
      frame->GetWebUI() || CliRefusedUrl(frame->GetLastCommittedURL())) {
    return true;
  }
  Profile* profile = Profile::FromBrowserContext(frame->GetBrowserContext());
  return profile && !IsInspectionAllowed(profile, frame);
}

bool CliAnyFrameRefused(content::WebContents* contents) {
  if (!contents || contents->IsBeingDestroyed()) {
    return true;
  }
  bool refused = false;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHostWithAction(
      [&](content::RenderFrameHost* frame) {
        if (frame->IsRenderFrameLive() && CliFrameRefused(frame)) {
          refused = true;
          return content::RenderFrameHost::FrameIterationAction::kStop;
        }
        return content::RenderFrameHost::FrameIterationAction::kContinue;
      });
  return refused;
}

std::optional<std::string> CliTabRefusal(content::WebContents* contents) {
  if (!contents || contents->IsBeingDestroyed()) {
    return "no such tab";
  }
  if (contents->GetBrowserContext()->IsOffTheRecord()) {
    ++CliCounts().refused;
    return "private tabs can't be read";
  }
  if (contents->GetWebUI() || CliRefusedUrl(contents->GetLastCommittedURL()) ||
      CliRefusedUrl(contents->GetVisibleURL())) {
    ++CliCounts().refused;
    return "Ardia's own and chrome:// pages can't be read";
  }
  Profile* profile = Profile::FromBrowserContext(contents->GetBrowserContext());
  if (!CliRemoteDebuggingAllowed() ||
      (profile && !IsInspectionAllowed(profile, contents)) ||
      CliFrameRefused(contents->GetPrimaryMainFrame())) {
    ++CliCounts().refused;
    return "DevTools is turned off for this tab by your administrator";
  }
  return std::nullopt;
}

CliPolicyWatch::CliPolicyWatch(content::WebContents* contents,
                               base::RepeatingClosure watcher)
    : changed_(std::move(watcher)) {
  const base::RepeatingClosure changed = base::BindRepeating(
      &CliPolicyWatch::Changed, weak_factory_.GetWeakPtr());
  Profile* profile =
      contents ? Profile::FromBrowserContext(contents->GetBrowserContext())
               : nullptr;
  if (profile && profile->GetPrefs()) {
    profile_.Init(profile->GetPrefs());
    profile_.Add(prefs::kDevToolsAvailability, changed);
    profile_.Add(prefs::kDeveloperToolsAvailabilityAllowlist, changed);
    profile_.Add(prefs::kDeveloperToolsAvailabilityBlocklist, changed);
    profile_.Add(policy::policy_prefs::kUrlBlocklist, changed);
    profile_.Add(policy::policy_prefs::kUrlAllowlist, changed);
  }
  if (profile) {
    if (policy::DeveloperToolsPolicyChecker* checker =
            policy::DeveloperToolsPolicyCheckerFactory::GetForBrowserContext(
                profile)) {
      matcher_ = checker->AddObserver(base::BindRepeating(
          &CliPolicyWatch::MatcherInstalled, weak_factory_.GetWeakPtr()));
    }
  }
  if (g_browser_process && g_browser_process->local_state()) {
    local_.Init(g_browser_process->local_state());
    local_.Add(prefs::kDevToolsRemoteDebuggingAllowed, changed);
  }
}

CliPolicyWatch::~CliPolicyWatch() = default;

void CliPolicyWatch::Changed() {
  changed_.Run();
  pending_rechecks_ = 3;
  later_.Start(FROM_HERE, base::Milliseconds(250),
               base::BindOnce(&CliPolicyWatch::Settled,
                              weak_factory_.GetWeakPtr()));
}

void CliPolicyWatch::MatcherInstalled() {
  changed_.Run();
}

void CliPolicyWatch::Settled() {
  changed_.Run();
  if (--pending_rechecks_ > 0) {
    later_.Start(FROM_HERE, base::Milliseconds(750),
                 base::BindOnce(&CliPolicyWatch::Settled,
                                weak_factory_.GetWeakPtr()));
  }
}

bool ValidCliOwner(std::string_view owner) {
  if (owner.empty() || owner.size() > 64) {
    return false;
  }
  for (char c : owner) {
    if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' ||
          c == ':')) {
      return false;
    }
  }
  return true;
}

int RegisterCliOp(std::string_view owner, base::OnceClosure cancel) {
  static int last = 0;
  const int id = ++last;
  Ops().emplace(id, Op{std::string(owner), std::move(cancel)});
  return id;
}

void FinishCliOp(int id) {
  Ops().erase(id);
}

int CancelCliOps(std::string_view owner) {
  std::vector<base::OnceClosure> cancels;
  for (auto it = Ops().begin(); it != Ops().end();) {
    if (it->second.owner == owner) {
      cancels.push_back(std::move(it->second.cancel));
      it = Ops().erase(it);
    } else {
      ++it;
    }
  }
  for (base::OnceClosure& cancel : cancels) {
    ++CliCounts().cancelled;
    std::move(cancel).Run();
  }
  return static_cast<int>(cancels.size()) + CloseCliDevToolsSessionsOf(owner);
}

}

AC_ARGS_CALL(ac_cli_cancel) {
  ardia::Reply out = call.TakeReply();
  if (call.Bool("all")) {
    return out.Send(
        base::DictValue().Set("cancelled", ardia::CancelAllCliOps()));
  }
  const std::string owner = call.String("owner");
  if (!ardia::ValidCliOwner(owner)) {
    return out.Error("bad owner");
  }
  out.Send(base::DictValue().Set("cancelled", ardia::CancelCliOps(owner)));
}
