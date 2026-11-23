// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_visible_tabs.h"

#include <algorithm>
#include <cstdint>
#include <map>
#include <string>
#include <utility>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/numerics/clamped_math.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "content/public/browser/browser_task_traits.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/web_contents.h"
#include "ui/gfx/geometry/size.h"

namespace ardia {

namespace {

constexpr char kRemoteDebuggerClient[] = "RemoteDebugger";
constexpr char kPortClientsKeepTabsVisible[] = "cdpTabsVisible";
constexpr bool kStayHidden = false;
constexpr bool kStayAwake = false;
constexpr bool kIsActivity = false;

struct VisibleHold {
  uint64_t id = 0;
  base::WeakPtr<content::WebContents> contents;
  base::ScopedClosureRunner capture;
};

std::map<const void*, VisibleHold>& Holds() {
  static base::NoDestructor<std::map<const void*, VisibleHold>> holds;
  return *holds;
}

struct HoldTotals {
  base::ClampedNumeric<int> started;
  base::ClampedNumeric<int> ended_before_start;
};

HoldTotals& Totals() {
  static HoldTotals totals;
  return totals;
}

std::map<const void*, VisibleHold>::iterator FindHold(uint64_t id) {
  return std::ranges::find_if(
      Holds(), [id](const auto& entry) { return entry.second.id == id; });
}

uint64_t NextHoldId() {
  static uint64_t last = 0;
  return ++last;
}

bool KeepsTabsVisible(content::DevToolsAgentHostClient* root_client) {
  if (!root_client ||
      root_client->GetTypeForMetrics() != kRemoteDebuggerClient) {
    return false;
  }
  return IsTokenClient(root_client) ||
         ardiacore::TestFlag(kPortClientsKeepTabsVisible);
}

bool IsTabTarget(content::DevToolsAgentHost* host) {
  const std::string type = host->GetType();
  return type == content::DevToolsAgentHost::kTypePage ||
         type == content::DevToolsAgentHost::kTypeFrame ||
         type == content::DevToolsAgentHost::kTypeTab;
}

void StartHold(uint64_t id) {
  auto it = FindHold(id);
  if (it == Holds().end()) {
    Totals().ended_before_start++;
    return;
  }
  content::WebContents* contents = it->second.contents.get();
  if (!contents || contents->IsBeingDestroyed()) {
    Holds().erase(it);
    return;
  }
  base::ScopedClosureRunner capture = contents->IncrementCapturerCount(
      gfx::Size(), kStayHidden, kStayAwake, kIsActivity);
  it = FindHold(id);
  if (it == Holds().end()) {
    Totals().ended_before_start++;
    return;
  }
  it->second.capture = std::move(capture);
  Totals().started++;
}

void SessionAttached(content::DevToolsAgentHostClient* root_client,
                     content::DevToolsAgentHost* host,
                     const void* session) {
  if (!session || !host || !IsTabTarget(host) ||
      !KeepsTabsVisible(root_client)) {
    return;
  }
  content::WebContents* contents = host->GetWebContents();
  if (!contents || contents->IsBeingDestroyed()) {
    return;
  }
  const uint64_t id = NextHoldId();
  Holds().insert_or_assign(
      session, VisibleHold{id, contents->GetWeakPtr(), {}});
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&StartHold, id));
}

void SessionDetached(const void* session) {
  auto node = Holds().extract(session);
  if (node.empty() || !node.mapped().capture) {
    return;
  }
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE,
      base::DoNothingWithBoundArgs(std::move(node.mapped().capture)));
}

}

base::DictValue CliVisibleHoldTotals() {
  return base::DictValue()
      .Set("started", static_cast<int>(Totals().started))
      .Set("endedBeforeStart", static_cast<int>(Totals().ended_before_start));
}

void InstallCliVisibleTabs() {
  g_ardia_devtools_session_attached = &SessionAttached;
  g_ardia_devtools_session_detached = &SessionDetached;
}

}
