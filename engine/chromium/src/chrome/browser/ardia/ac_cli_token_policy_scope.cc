// Copyright 2026 Ardia. Apache-2.0.

#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_act_leases.h"
#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"
#include "chrome/browser/ardia/ac_cli_test_signals.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "chrome/browser/ardia/ac_cli_visible_tabs.h"
#include "content/public/browser/devtools_agent_host.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

std::string OutOfScopeReply(int id, const std::string& session) {
  return ErrorReply(id, session, kRefused,
                    refusal::kOutOfScope);
}

bool IsBrowserHost(content::DevToolsAgentHost* host) {
  return host && host->GetType() == content::DevToolsAgentHost::kTypeBrowser;
}

}

content::DevToolsAgentHost* TokenClient::HostOf(const std::string& session) {
  if (session.empty()) {
    return root_host_.get();
  }
  auto it = targets_.find(session);
  return it == targets_.end()
             ? nullptr
             : content::ArdiaDevToolsAgentHostForId(it->second);
}

bool TokenClient::SessionInScope(const std::string& session) {
  if (left_.contains(session)) {
    return false;
  }
  auto it = targets_.find(session);
  return it != targets_.end() && PluginMayAttachToTargetId(*scope_, &it->second);
}

bool TokenClient::MayInputTo(content::RenderFrameHost* frame) {
  if (!frame || revoked_ || wedged_ || draining_ || !RootInScope() ||
      !PluginMayAttachToFrame(*scope_, frame)) {
    return false;
  }
  return ActLeaseCoversFrame(scope_->credential_id, frame);
}

ArdiaSessionInput TokenClient::MaySessionInput(const std::string& session,
                                               int64_t grant,
                                               bool delivering) {
  if (revoked_ || wedged_ || draining_ || !RootInScope()) {
    return ArdiaSessionInput::kRefused;
  }
  if (session.empty()) {
    if (IsBrowserHost(root_host_.get())) {
      return ArdiaSessionInput::kRefused;
    }
  } else if (detaching_.contains(session)) {
    CountPluginDeliveryRefusedDeparted();
    return ArdiaSessionInput::kRefused;
  } else if (!targets_.contains(session) || !SessionInScope(session)) {
    return ArdiaSessionInput::kRefused;
  }
  return DeliveryGrantLive(session, grant, delivering)
             ? ArdiaSessionInput::kAllowed
                                           : ArdiaSessionInput::kLeaseEnded;
}

bool TokenClient::RootInScope() {
  return IsBrowserHost(root_host_.get()) ||
         (!root_left_ && PluginTargetInScope(*scope_, root_host_.get()));
}

void TokenClient::WatchTab(const std::string& session) {
  content::DevToolsAgentHost* host = HostOf(session);
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  tabs::TabInterface* tab =
      contents ? tabs::TabInterface::MaybeGetFromContents(contents) : nullptr;
  if (!tab) {
    return;
  }
  TabWatch watch;
  watch.will_detach = tab->RegisterWillDetach(base::BindRepeating(
      [](base::WeakPtr<TokenClient> self, std::string watched,
         tabs::TabInterface* tab, tabs::TabInterface::DetachReason reason) {
        if (self) {
          self->TabLeftWindow(watched);
        }
      },
      weak_factory_.GetWeakPtr(), session));
  watch.did_insert = tab->RegisterDidInsert(base::BindRepeating(
      [](base::WeakPtr<TokenClient> self, tabs::TabInterface* tab) {
        if (!self) {
          return;
        }
        base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
            FROM_HERE, base::BindOnce(&TokenClient::CheckScope, self));
      },
      weak_factory_.GetWeakPtr()));
  if (session.empty()) {
    root_tab_watch_ = std::move(watch);
  } else {
    tab_watches_[session] = std::move(watch);
  }
}

void TokenClient::DepartTabOf(const std::string& session) {
  content::DevToolsAgentHost* host = HostOf(session);
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  if (contents && !PluginTabInScope(scope_->credential_id, contents)) {
    PluginTabDeparted(scope_->credential_id, contents);
    ActLeaseTabDeparted(scope_->credential_id, contents);
  }
}

void TokenClient::TabLeftWindow(const std::string& session) {
  content::DevToolsAgentHost* host = HostOf(session);
  PluginTabDeparted(scope_->credential_id,
                    host ? host->GetWebContents() : nullptr);
  ActLeaseTabDeparted(scope_->credential_id,
                      host ? host->GetWebContents() : nullptr);
  if (session.empty()) {
    root_left_ = true;
  } else {
    left_.insert(session);
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](base::WeakPtr<TokenClient> self, std::string gone) {
                       if (!self) {
                         return;
                       }
                       if (gone.empty()) {
                         self->CloseOutOfScope();
                       } else {
                         self->DetachOutOfScope(gone);
                       }
                     },
                     weak_factory_.GetWeakPtr(), session));
}

bool TokenClient::FilterPluginReply(int id,
                                    const std::string& session,
                                    std::string& message) {
  if (session.empty() ? RootInScope() : SessionInScope(session)) {
    return true;
  }
  message = OutOfScopeReply(id, session);
  if (!session.empty()) {
    DetachOutOfScope(session);
  } else {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<TokenClient> self) {
                         if (self) {
                           self->CloseOutOfScope();
                         }
                       },
                       weak_factory_.GetWeakPtr()));
  }
  return false;
}

bool TokenClient::PluginCommandAllowed(int id,
                                       const std::string& session,
                                       const std::string& method,
                                       base::DictValue& params,
                                       std::string* reply,
                                       int64_t* grant) {
  if (!session.empty() && !SessionInScope(session)) {
    *reply = OutOfScopeReply(id, session);
    DetachOutOfScope(session);
    return false;
  }
  if (session.empty() && !RootInScope()) {
    *reply = OutOfScopeReply(id, session);
    CloseOutOfScope();
    return false;
  }
  PluginCommandContext context;
  context.on_root_session = session.empty();
  context.session_known = base::BindRepeating(
      [](TokenClient* self, const std::string& value) {
        return self->targets_.contains(value);
      },
      base::Unretained(this));
  const std::string refusal = PluginRefusal(*scope_, method, params, context);
  if (refusal.empty()) {
    return ActLeaseAdmits(id, session, method, reply, grant);
  }
  ++PluginTotalsSoFar().refused;
  *reply = ErrorReply(id, session, kMethodNotAllowed,
                      base::StrCat({refusal::kPrefix, method, " ", refusal,
                                    refusal::kNotAllowedForPluginSuffix}));
  return false;
}

void TokenClient::SendInternal(const std::string& session,
                               const std::string& method,
                               base::DictValue params) {
  if (!to_browser_) {
    CloseOutOfScope();
    return;
  }
  int id = 0;
  do {
    id = std::numeric_limits<int>::min() + next_internal_id_++;
  } while (outstanding_.contains({session, id}));
  outstanding_[{session, id}] = kInternalCommand;
  base::DictValue command;
  command.Set("id", id);
  command.Set("method", method);
  command.Set("params", std::move(params));
  if (!session.empty()) {
    command.Set("sessionId", session);
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<TokenClient> self, std::string json) {
            if (self && self->to_browser_ && !self->revoked_) {
              self->to_browser_.Run(std::move(json));
            }
          },
          weak_factory_.GetWeakPtr(),
          base::WriteJson(command).value_or(std::string())));
}

void TokenClient::DetachOutOfScope(const std::string& session) {
  if (detaching_.contains(session) || !targets_.contains(session)) {
    return;
  }
  DepartTabOf(session);
  for (const std::string& gone : Subtree(session)) {
    for (const auto& [key, method] : outstanding_) {
      if (key.first == gone && method != kInternalCommand && to_client_) {
        to_client_.Run(OutOfScopeReply(key.second, gone));
      }
    }
  }
  auto parent = parents_.find(session);
  const std::string parent_session =
      parent == parents_.end() ? std::string() : parent->second;
  for (const std::string& gone : Subtree(session)) {
    detaching_[gone] = session;
  }
  DropSubtree(session);
  if (CliPluginInputHold()) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<TokenClient> self, std::string parent,
               std::string gone) {
              if (self) {
                self->SendInternal(parent, "Target.detachFromTarget",
                                   base::DictValue().Set("sessionId", gone));
              }
            },
            weak_factory_.GetWeakPtr(), parent_session, session),
        kHeldPluginDetach);
    return;
  }
  SendInternal(parent_session, "Target.detachFromTarget",
               base::DictValue().Set("sessionId", session));
}

void TokenClient::CloseOutOfScope() {
  if (wedged_ || draining_) {
    return;
  }
  DepartTabOf(std::string());
  for (const auto& [key, method] : outstanding_) {
    if (method != kInternalCommand && to_client_) {
      to_client_.Run(OutOfScopeReply(key.second, key.first));
    }
  }
  outstanding_.clear();
  SettleCommandState();
  draining_ = true;
  if (closer_) {
    closer_.Run(false);
  }
}

void TokenClient::CheckScope() {
  if (!PluginCredentialLive(scope_->credential_id)) {
    Revoke();
    return;
  }
  if (!RootInScope()) {
    CloseOutOfScope();
    return;
  }
  std::vector<std::string> gone;
  for (const auto& [session, target] : targets_) {
    if (!detaching_.contains(session) &&
        !PluginMayAttachToTargetId(*scope_, &target)) {
      gone.push_back(session);
    }
  }
  for (const std::string& session : gone) {
    DetachOutOfScope(session);
  }
}

bool TokenClient::FilterPluginEvent(std::string_view method,
                                    std::string_view session_view,
                                    std::string& message) {
  const std::string session(session_view);
  if (!session.empty()) {
    if (detaching_.contains(session) || !targets_.contains(session)) {
      return false;
    }
    if (!SessionInScope(session)) {
      DetachOutOfScope(session);
      return false;
    }
  } else if (!RootInScope()) {
    CloseOutOfScope();
    return false;
  }
  if (method == "Target.attachedToTarget" ||
      method == "Target.detachedFromTarget") {
    return FilterTargetEvent(method, message);
  }
  if (method == "Target.targetInfoChanged" ||
      method == "Target.targetDestroyed") {
    std::optional<base::Value> parsed =
        base::JSONReader::Read(message, base::JSON_PARSE_RFC);
    const base::DictValue* params =
        parsed && parsed->is_dict() ? parsed->GetDict().FindDict("params")
                                    : nullptr;
    const base::DictValue* info =
        params ? params->FindDict("targetInfo") : nullptr;
    const std::string* target_id =
        info ? info->FindString("targetId")
             : (params ? params->FindString("targetId") : nullptr);
    if (!target_id || !told_targets_.contains(*target_id)) {
      return false;
    }
    if (method == "Target.targetDestroyed") {
      told_targets_.erase(*target_id);
      return true;
    }
    if (!PluginMayAttachToTargetId(*scope_, target_id)) {
      return false;
    }
    ScrubPluginTargetInfo(*scope_, parsed->GetDict().FindDict("params")
                                       ->FindDict("targetInfo"));
    message = base::WriteJson(*parsed).value_or(std::string());
    return !message.empty();
  }
  if (method == "Inspector.detached" || method == "Inspector.targetCrashed") {
    ForgetSessionOf(message);
    return true;
  }
  return PluginForwardsEvent(method);
}

}
}
