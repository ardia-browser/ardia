// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_OPS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_OPS_H_

#include <cstdint>
#include <string>
#include <string_view>

#include <optional>

#include "base/callback_list.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/timer/timer.h"
#include "components/prefs/pref_change_registrar.h"
#include "base/values.h"

class GURL;

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace ardia {

struct EngineCliCounts {
  uint64_t sessions_opened = 0;
  uint64_t sessions_refused = 0;
  uint64_t session_commands = 0;
  uint64_t session_events = 0;
  uint64_t session_events_cut = 0;
  uint64_t snapshots = 0;
  uint64_t snapshots_failed = 0;
  uint64_t snapshot_refs = 0;
  uint64_t snapshots_modal = 0;
  uint64_t occluded_refs = 0;
  uint64_t settles = 0;
  uint64_t settles_timed_out = 0;
  uint64_t settle_ms = 0;
  uint64_t hit_tests = 0;
  uint64_t clicks = 0;
  uint64_t clicks_blocked = 0;
  uint64_t dismiss_found = 0;
  uint64_t refs_rebound = 0;
  uint64_t refs_stale = 0;
  uint64_t screenshots = 0;
  uint64_t screenshots_hidden = 0;
  uint64_t screenshots_failed = 0;
  uint64_t cancelled = 0;
  uint64_t clicks_unverified = 0;
  uint64_t refused = 0;
};

EngineCliCounts& CliCounts();

base::DictValue EngineCliTotals();

int RegisterCliOp(std::string_view owner, base::OnceClosure cancel);

void FinishCliOp(int id);

int CancelCliOps(std::string_view owner);

int CancelAllCliOps();

std::optional<std::string> CliTabRefusal(content::WebContents* contents);

bool CliFrameRefused(content::RenderFrameHost* frame);

bool CliAnyFrameRefused(content::WebContents* contents);

bool CliRefusedUrl(const GURL& url);

bool CliRemoteDebuggingAllowed();

bool ValidCliOwner(std::string_view owner);

class CliPolicyWatch {
 public:
  CliPolicyWatch(content::WebContents* contents, base::RepeatingClosure changed);
  CliPolicyWatch(const CliPolicyWatch&) = delete;
  CliPolicyWatch& operator=(const CliPolicyWatch&) = delete;
  ~CliPolicyWatch();

 private:
  void Changed();
  void MatcherInstalled();
  void Settled();

  base::RepeatingClosure changed_;
  PrefChangeRegistrar profile_;
  PrefChangeRegistrar local_;
  base::CallbackListSubscription matcher_;
  base::OneShotTimer later_;
  int pending_rechecks_ = 0;
  base::WeakPtrFactory<CliPolicyWatch> weak_factory_{this};
};

}

#endif
