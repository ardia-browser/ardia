// Copyright 2026 Ardia. Apache-2.0.

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/location.h"
#include "ardia/core/ac_plugin_refusals.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/ardia/ac_cli_act_lease_book.h"
#include "chrome/browser/ardia/ac_cli_act_leases.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "content/public/browser/devtools_agent_host.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

constexpr base::TimeDelta kActionDeadline = base::Seconds(10);

}

bool TokenClient::ActLeaseAdmits(int id,
                                 const std::string& session,
                                 const std::string& method,
                                 std::string* reply,
                                 int64_t* grant) {
  *grant = 0;
  dispatching_ = false;
  if (IsActWithheldMethod(method)) {
    ++PluginTotalsSoFar().refused;
    *reply = ErrorReply(id, session, kMethodNotAllowed,
                        base::StrCat({refusal::kPrefix, method,
                                      refusal::kNotAllowedForPluginSuffix}));
    return false;
  }
  if (!IsActLeasedMethod(method)) {
    return true;
  }
  const int64_t lease = AdmitActLease(scope_->credential_id, HostOf(session));
  *grant = lease ? ActLeaseActionAdmitted(lease) : 0;
  if (!*grant) {
    ++PluginTotalsSoFar().refused;
    CountActCommandRefused();
    *reply = ErrorReply(id, session, kRefused, refusal::kActLeaseMissing);
    return false;
  }
  admitted_actions_[{session, id}] = *grant;
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&TokenClient::ExpireAction, weak_factory_.GetWeakPtr(),
                     std::make_pair(session, id), *grant),
      kActionDeadline);
  return true;
}

void TokenClient::ExpireAction(std::pair<std::string, int> key,
                               int64_t ticket) {
  auto it = admitted_actions_.find(key);
  if (it == admitted_actions_.end() || it->second != ticket) {
    return;
  }
  admitted_actions_.erase(it);
  auto waiting = outstanding_.find(key);
  if (waiting != outstanding_.end() && waiting->second != kInternalCommand) {
    const bool pointer = pointer_runs_.erase(key) > 0;
    const bool maybe_delivered = !pointer || ActTicketDelivered(ticket);
    if (pointer) {
      outstanding_.erase(waiting);
    } else {
      waiting->second = kInternalCommand;
    }
    if (to_client_ && !revoked_) {
      to_client_.Run(ErrorReply(key.second, key.first, kRefused,
                                maybe_delivered ? refusal::kOutcomeUnknown
                                                : refusal::kActLeaseEnded));
    }
  }
  ActLeaseActionsReturned({ticket});
}

void TokenClient::SettleCommandState() {
  if (!pointer_runs_.empty()) {
    std::erase_if(pointer_runs_, [&](const auto& entry) {
      return !outstanding_.contains(entry.first);
    });
  }
  if (kind_ == TokenKind::kPlugin) {
    ReconcileActions();
  }
}

void TokenClient::ReconcileActions() {
  if (admitted_actions_.empty()) {
    return;
  }
  std::vector<int64_t> returned;
  for (auto it = admitted_actions_.begin(); it != admitted_actions_.end();) {
    if (outstanding_.contains(it->first)) {
      ++it;
      continue;
    }
    returned.push_back(it->second);
    it = admitted_actions_.erase(it);
  }
  if (!returned.empty()) {
    ActLeaseActionsReturned(returned);
  }
}

bool TokenClient::AttachedTo(content::WebContents* contents) const {
  if (revoked_ || wedged_) {
    return false;
  }
  if (!draining_ && !root_left_ && root_host_ &&
      root_host_->GetType() != content::DevToolsAgentHost::kTypeBrowser &&
      root_host_->GetWebContents() == contents) {
    return true;
  }
  for (const auto& [session, target] : targets_) {
    if (left_.contains(session) || detaching_.contains(session)) {
      continue;
    }
    content::DevToolsAgentHost* host =
        content::ArdiaDevToolsAgentHostForId(target);
    if (host && host->GetWebContents() == contents) {
      return true;
    }
  }
  return false;
}

void TokenClient::NoteSessionsLeft() {
  if (kind_ == TokenKind::kPlugin) {
    ActLeaseSessionsLeft(scope_->credential_id);
  }
}

void ActLeaseSessionsLeft(const std::string& credential_id) {
  EndActLeasesWithoutSession(
      credential_id, [&](content::WebContents* contents) {
        for (const auto& [root, client] : Registry()) {
          if (client->kind() == TokenKind::kPlugin &&
              client->scope()->credential_id == credential_id &&
              client->AttachedTo(contents)) {
            return true;
          }
        }
        return false;
      });
}

void TokenClient::ReturnAllActions() {
  if (admitted_actions_.empty()) {
    return;
  }
  std::vector<int64_t> returned;
  for (const auto& [key, ticket] : std::exchange(admitted_actions_, {})) {
    returned.push_back(ticket);
  }
  ActLeaseActionsReturned(returned);
}

bool TokenClient::DeliveryGrantLive(const std::string& session,
                                    int64_t grant,
                                    bool delivering) {
  if (ActTicketLive(grant, scope_->credential_id, HostOf(session))) {
    if (delivering) {
      ActTicketDelivering(grant);
    }
    return true;
  }
  CountActDeliveryRefused();
  return false;
}

int64_t TokenClient::InputGrant(const std::string& session) const {
  return dispatching_ && dispatching_session_ == session ? dispatching_grant_
                                                         : 0;
}

void TokenClient::NoteDispatchingGrant(const std::string& session,
                                       int64_t grant) {
  dispatching_session_.assign(session);
  dispatching_grant_ = grant;
  dispatching_ = true;
}

}
}
