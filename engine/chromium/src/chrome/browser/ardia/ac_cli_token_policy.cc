// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_token_policy.h"

#include <array>
#include <cstdint>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_host_visibility.h"
#include "base/json/json_reader.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_page_signals.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

struct CountedDomain {
  std::string_view domain;
  std::string_view field;
};

constexpr std::array<CountedDomain, 12> kCountedDomains = {{
    {"Accessibility", "accessibility"},
    {"Ardia", "ardia"},
    {"Browser", "browser"},
    {"DOM", "dom"},
    {"Emulation", "emulation"},
    {"Fetch", "fetch"},
    {"Input", "input"},
    {"Network", "network"},
    {"Page", "page"},
    {"Runtime", "runtime"},
    {"Storage", "storage"},
    {"Target", "target"},
}};

constexpr size_t kOtherDomain = kCountedDomains.size();

std::array<uint64_t, kCountedDomains.size() + 1>& CommandTotals() {
  static std::array<uint64_t, kCountedDomains.size() + 1> totals = {};
  return totals;
}

int ClampedCount(uint64_t count) {
  return count > static_cast<uint64_t>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(count);
}

}

std::string ErrorReply(int id,
                       const std::string& session,
                       int code,
                       const std::string& message) {
  base::DictValue error;
  error.Set("code", code);
  error.Set("message", message);
  base::DictValue reply;
  reply.Set("id", id);
  if (!session.empty()) {
    reply.Set("sessionId", session);
  }
  reply.Set("error", std::move(error));
  return base::WriteJson(reply).value_or("{}");
}

std::map<content::DevToolsAgentHostClient*, TokenClient*>& Registry() {
  static base::NoDestructor<
      std::map<content::DevToolsAgentHostClient*, TokenClient*>>
      registry;
  return *registry;
}

bool NeedsResponse(std::string_view method) {
  return method == "Target.getTargets" || method == "Target.getTargetInfo" ||
         method == "Target.createTarget";
}

bool IsOffscreenTarget(const std::string* target_id) {
  content::DevToolsAgentHost* host =
      target_id ? content::ArdiaDevToolsAgentHostForId(*target_id) : nullptr;
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  return contents && ardiacore::InAutomationWindow(contents);
}

void CountCommand(std::string_view method) {
  const std::string_view domain = method.substr(0, method.find('.'));
  for (size_t i = 0; i < kCountedDomains.size(); ++i) {
    if (kCountedDomains[i].domain == domain) {
      ++CommandTotals()[i];
      return;
    }
  }
  ++CommandTotals()[kOtherDomain];
}

TokenClient::TokenClient(content::DevToolsAgentHostClient* client,
                         content::DevToolsAgentHost* host)
    : client_(client), host_(host) {
  Registry()[client_] = this;
}

TokenClient::~TokenClient() {
  Registry().erase(client_);
}

bool TokenClient::FilterCommand(std::string& message, std::string* reply) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    *reply = ErrorReply(0, std::string(), kParseError,
                        "ardia: a command must be a JSON object");
    return false;
  }
  base::DictValue& command = parsed->GetDict();
  const std::string* session_id = command.FindString("sessionId");
  const std::string session = session_id ? *session_id : std::string();
  std::optional<int> id = command.FindInt("id");
  const std::string* method = command.FindString("method");
  if (!id || !method || (command.Find("sessionId") && !session_id)) {
    *reply = ErrorReply(id.value_or(0), session, kInvalidRequest,
                        "ardia: a command needs an id and a method");
    return false;
  }
  for (auto [key, value] : command) {
    if (key != "id" && key != "method" && key != "params" &&
        key != "sessionId") {
      *reply = ErrorReply(*id, session, kInvalidRequest,
                          base::StrCat({"ardia: a command can't carry ", key}));
      return false;
    }
  }
  if (session_id && !targets_.contains(session)) {
    *reply = ErrorReply(*id, std::string(), kInvalidRequest,
                        "ardia: no attached session has that sessionId");
    return false;
  }
  if (command.Find("params") && !command.FindDict("params")) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        "ardia: params must be an object");
    return false;
  }
  const std::pair<std::string, int> key(session, *id);
  if (outstanding_.contains(key)) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        "ardia: a command with that id is still waiting for "
                        "its reply");
    return false;
  }
  if (outstanding_.size() >= kMaxPending) {
    *reply = ErrorReply(*id, session, kRefused,
                        "ardia: too many commands are waiting for replies; "
                        "closing the connection");
    wedged_ = true;
    return false;
  }
  CountCommand(*method);
  if (IsPageSignalMethod(*method)) {
    return StartPageSignal(*id, session, *method, command.FindDict("params"),
                           reply);
  }
  outstanding_[key] = NeedsResponse(*method) ? *method : std::string();
  message = base::WriteJson(command).value_or(std::string());
  if (message.empty()) {
    outstanding_.erase(key);
    return false;
  }
  return true;
}

bool TokenClient::StartPageSignal(int id,
                                  const std::string& session,
                                  const std::string& method,
                                  const base::DictValue* params,
                                  std::string* reply) {
  auto bound = targets_.find(session);
  content::DevToolsAgentHost* target =
      session.empty() || bound == targets_.end()
          ? nullptr
          : content::ArdiaDevToolsAgentHostForId(bound->second);
  const std::string type = target ? target->GetType() : std::string();
  content::WebContents* contents = target ? target->GetWebContents() : nullptr;
  if (!contents || (type != content::DevToolsAgentHost::kTypePage &&
                    type != content::DevToolsAgentHost::kTypeTab)) {
    *reply = ErrorReply(id, session, kInvalidParams,
                        "ardia: send this on a session attached to a tab");
    return false;
  }
  const base::DictValue empty;
  const std::pair<std::string, int> key(session, id);
  outstanding_[key] = std::string();
  running_[key] = RunPageSignal(
      method, params ? *params : empty, contents,
      base::BindOnce(&TokenClient::PageSignalAnswered,
                     weak_factory_.GetWeakPtr(), id, session));
  return false;
}

void TokenClient::PageSignalAnswered(
    int id,
    const std::string& session,
    base::expected<base::DictValue, std::string> outcome) {
  if (auto running = running_.find({session, id}); running != running_.end()) {
    std::ignore = running->second.Release();
    running_.erase(running);
  }
  if (!outstanding_.contains({session, id}) || !host_) {
    return;
  }
  std::string message;
  if (outcome.has_value()) {
    base::DictValue answer;
    answer.Set("id", id);
    if (!session.empty()) {
      answer.Set("sessionId", session);
    }
    answer.Set("result", std::move(outcome.value()));
    message = base::WriteJson(answer).value_or(std::string());
  }
  if (message.empty()) {
    message = ErrorReply(id, session, kRefused,
                         outcome.has_value() ? "ardia: the answer isn't JSON"
                                             : outcome.error());
  }
  client_->DispatchProtocolMessage(host_.get(), base::as_byte_span(message));
}

bool TokenClient::ShouldClose() const {
  return wedged_;
}

bool TokenClient::MayAttachToURL(const GURL& url, bool is_webui) {
  return true;
}

bool TokenClient::MayAttachToRenderFrameHost(content::RenderFrameHost* frame) {
  return true;
}

}

std::unique_ptr<ArdiaDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host) {
  return std::make_unique<cli_token_policy_internal::TokenClient>(client, host);
}

bool IsTokenClient(content::DevToolsAgentHostClient* root_client) {
  return cli_token_policy_internal::Registry().contains(root_client);
}

base::DictValue TokenCommandTotals() {
  using cli_token_policy_internal::ClampedCount;
  using cli_token_policy_internal::CommandTotals;
  using cli_token_policy_internal::kCountedDomains;
  using cli_token_policy_internal::kOtherDomain;
  base::DictValue totals;
  for (size_t i = 0; i < kCountedDomains.size(); ++i) {
    totals.Set(kCountedDomains[i].field, ClampedCount(CommandTotals()[i]));
  }
  totals.Set("other", ClampedCount(CommandTotals()[kOtherDomain]));
  return totals;
}

}
