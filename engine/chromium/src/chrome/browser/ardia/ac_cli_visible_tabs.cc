// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_visible_tabs.h"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"
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

struct PluginSession {
  std::string credential_id;
  base::WeakPtr<content::WebContents> contents;
  bool departed = false;
};

using PluginHoldKey = std::pair<std::string, const content::WebContents*>;

struct PluginHold {
  base::WeakPtr<content::WebContents> contents;
  base::ScopedClosureRunner capture;
  uint64_t token = 0;
};

std::map<const void*, VisibleHold>& Holds() {
  static base::NoDestructor<std::map<const void*, VisibleHold>> holds;
  return *holds;
}

std::map<const void*, PluginSession>& PluginSessions() {
  static base::NoDestructor<std::map<const void*, PluginSession>> sessions;
  return *sessions;
}

std::map<PluginHoldKey, PluginHold>& PluginHolds() {
  static base::NoDestructor<std::map<PluginHoldKey, PluginHold>> holds;
  return *holds;
}

int& HeldPluginCaptures() {
  static int held = 0;
  return held;
}

base::ScopedClosureRunner CountedCapture(content::WebContents* contents) {
  base::ScopedClosureRunner capture = contents->IncrementCapturerCount(
      gfx::Size(), kStayHidden, kStayAwake, kIsActivity);
  ++HeldPluginCaptures();
  return base::ScopedClosureRunner(base::BindOnce(
      [](base::ScopedClosureRunner inner) {
        --HeldPluginCaptures();
        inner.RunAndReset();
      },
      std::move(capture)));
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
  const std::optional<TokenKind> kind = TokenClientKind(root_client);
  if (kind.has_value()) {
    return *kind == TokenKind::kCli;
  }
  return ardiacore::TestFlag(kPortClientsKeepTabsVisible);
}

bool IsTabTarget(content::DevToolsAgentHost* host) {
  const std::string type = host->GetType();
  return type == content::DevToolsAgentHost::kTypePage ||
         type == content::DevToolsAgentHost::kTypeFrame ||
         type == content::DevToolsAgentHost::kTypeTab;
}

bool HasPluginSession(const std::string& credential_id,
                      const content::WebContents* contents) {
  for (const auto& [session, attached] : PluginSessions()) {
    if (!attached.departed && attached.credential_id == credential_id &&
        attached.contents.get() == contents) {
      return true;
    }
  }
  return false;
}

PluginTabHold PluginHoldAllowed(const std::string& credential_id,
                                content::WebContents* contents) {
  if (!PluginCredentialLive(credential_id)) {
    return PluginTabHold::kNoCredential;
  }
  if (!PluginTabInScope(credential_id, contents)) {
    return PluginTabHold::kOutOfScope;
  }
  if (!HasPluginSession(credential_id, contents)) {
    return PluginTabHold::kNoSession;
  }
  return PluginTabHold::kOk;
}

void ReleaseLater(base::ScopedClosureRunner capture) {
  if (!capture) {
    return;
  }
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::DoNothingWithBoundArgs(std::move(capture)));
}

void DropPluginHold(const PluginHoldKey& key) {
  auto node = PluginHolds().extract(key);
  if (!node.empty()) {
    ReleaseLater(std::move(node.mapped().capture));
  }
}

void StartHold(const void* session, uint64_t id) {
  auto it = Holds().find(session);
  if (it == Holds().end() || it->second.id != id) {
    return;
  }
  content::WebContents* contents = it->second.contents.get();
  if (!contents || contents->IsBeingDestroyed()) {
    Holds().erase(it);
    return;
  }
  base::ScopedClosureRunner capture = contents->IncrementCapturerCount(
      gfx::Size(), kStayHidden, kStayAwake, kIsActivity);
  it = Holds().find(session);
  if (it != Holds().end() && it->second.id == id) {
    it->second.capture = std::move(capture);
  }
}

void NotePluginSession(content::DevToolsAgentHostClient* root_client,
                       content::DevToolsAgentHost* host,
                       const void* session) {
  std::optional<std::string> credential_id = PluginCredentialOf(root_client);
  content::WebContents* contents = host->GetWebContents();
  if (!credential_id || !contents || contents->IsBeingDestroyed()) {
    return;
  }
  PluginSessions().insert_or_assign(
      session, PluginSession{std::move(*credential_id),
                             contents->GetWeakPtr()});
}

void SessionAttached(content::DevToolsAgentHostClient* root_client,
                     content::DevToolsAgentHost* host,
                     const void* session) {
  if (!session || !host || !IsTabTarget(host)) {
    return;
  }
  if (!KeepsTabsVisible(root_client)) {
    NotePluginSession(root_client, host, session);
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
      FROM_HERE, base::BindOnce(&StartHold, session, id));
}

void SessionDetached(const void* session) {
  auto plugin = PluginSessions().extract(session);
  if (!plugin.empty()) {
    const PluginSession& gone = plugin.mapped();
    const content::WebContents* contents = gone.contents.get();
    if (contents && !HasPluginSession(gone.credential_id, contents)) {
      DropPluginHold({gone.credential_id, contents});
    }
    return;
  }
  auto node = Holds().extract(session);
  if (!node.empty()) {
    ReleaseLater(std::move(node.mapped().capture));
  }
}

}

PluginTabHold SetPluginTabVisibleHold(const std::string& credential_id,
                                      content::WebContents* contents,
                                      bool on) {
  const PluginHoldKey key{credential_id, contents};
  auto held = PluginHolds().find(key);
  if (held != PluginHolds().end() && !held->second.contents) {
    PluginHolds().erase(held);
    held = PluginHolds().end();
  }
  if (!on) {
    if (held != PluginHolds().end()) {
      base::ScopedClosureRunner capture = std::move(held->second.capture);
      PluginHolds().erase(held);
    }
    return PluginTabHold::kOk;
  }
  const PluginTabHold allowed = PluginHoldAllowed(credential_id, contents);
  if (allowed != PluginTabHold::kOk) {
    return allowed;
  }
  if (held != PluginHolds().end()) {
    return held->second.capture ? PluginTabHold::kOk
                                : PluginTabHold::kInProgress;
  }
  const base::WeakPtr<content::WebContents> weak = contents->GetWeakPtr();
  const uint64_t token = NextHoldId();
  PluginHolds().insert_or_assign(key, PluginHold{weak, {}, token});
  base::ScopedClosureRunner capture = CountedCapture(contents);
  const PluginTabHold still =
      weak ? PluginHoldAllowed(credential_id, weak.get())
           : PluginTabHold::kNoSession;
  auto reserved = PluginHolds().find(key);
  const bool ours = reserved != PluginHolds().end() &&
                    reserved->second.token == token;
  if (!ours || !weak || still != PluginTabHold::kOk) {
    if (ours) {
      PluginHolds().erase(reserved);
    }
    return still != PluginTabHold::kOk ? still : PluginTabHold::kInProgress;
  }
  reserved->second.capture = std::move(capture);
  ++PluginTotalsSoFar().holds;
  return PluginTabHold::kOk;
}

void PluginTabDeparted(const std::string& credential_id,
                       content::WebContents* contents) {
  if (!contents) {
    return;
  }
  for (auto& [session, attached] : PluginSessions()) {
    if (attached.credential_id == credential_id &&
        attached.contents.get() == contents) {
      attached.departed = true;
    }
  }
  auto node = PluginHolds().extract(PluginHoldKey(credential_id, contents));
  if (!node.empty()) {
    base::ScopedClosureRunner capture = std::move(node.mapped().capture);
  }
}

void ReleasePluginTabVisibleHolds(const std::string& credential_id) {
  std::vector<PluginHoldKey> keys;
  for (const auto& [key, hold] : PluginHolds()) {
    if (key.first == credential_id) {
      keys.push_back(key);
    }
  }
  for (const PluginHoldKey& key : keys) {
    DropPluginHold(key);
  }
}

bool PluginTabVisibleHoldHeld(const std::string& credential_id,
                              content::WebContents* contents) {
  auto held = PluginHolds().find(PluginHoldKey{credential_id, contents});
  return held != PluginHolds().end() && held->second.contents &&
         held->second.capture;
}

int PluginTabVisibleHoldCount() {
  return HeldPluginCaptures();
}

void InstallCliVisibleTabs() {
  g_ardia_devtools_session_attached = &SessionAttached;
  g_ardia_devtools_session_detached = &SessionDetached;
}

}
