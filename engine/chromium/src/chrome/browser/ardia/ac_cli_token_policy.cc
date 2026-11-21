// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_token_policy.h"

#include <algorithm>
#include <array>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_host_visibility.h"
#include "ardia/core/ac_pointer_outcome.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/no_destructor.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_act_leases.h"
#include "chrome/browser/ardia/ac_cli_file_picker.h"
#include "chrome/browser/ardia/ac_cli_owned_tabs.h"
#include "chrome/browser/ardia/ac_cli_test_signals.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "chrome/browser/ardia/ac_cli_visible_tabs.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "url/gurl.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

constexpr std::array<std::pair<std::string_view, CommandDomain>, 11>
    kCountedDomains = {{
        {"Target", CommandDomain::kTarget},
        {"Page", CommandDomain::kPage},
        {"Runtime", CommandDomain::kRuntime},
        {"DOM", CommandDomain::kDom},
        {"Input", CommandDomain::kInput},
        {"Network", CommandDomain::kNetwork},
        {"Emulation", CommandDomain::kEmulation},
        {"Browser", CommandDomain::kBrowser},
        {"Storage", CommandDomain::kStorage},
        {"Fetch", CommandDomain::kFetch},
        {"Accessibility", CommandDomain::kAccessibility},
    }};

constexpr std::array<std::string_view, static_cast<size_t>(CommandDomain::kCount)>
    kDomainNames = {"target",  "page",      "runtime", "dom",
                    "input",   "network",   "emulation", "browser",
                    "storage", "fetch",     "accessibility", "other"};

std::array<int, static_cast<size_t>(CommandDomain::kCount)>& CommandCounts() {
  static std::array<int, static_cast<size_t>(CommandDomain::kCount)> counts =
      {};
  return counts;
}

bool NeedsResponse(const std::string& method) {
  return method == "Target.getTargets" || method == "Target.getTargetInfo" ||
         method == "Target.createTarget";
}

ardia::OutstandingSlots<WheelSlot>& PluginWheelSlots() {
  static base::NoDestructor<ardia::OutstandingSlots<WheelSlot>> slots;
  return *slots;
}

std::vector<TokenClient*> ClientsOf(const std::string& credential_id) {
  std::vector<TokenClient*> clients;
  for (const auto& [root, client] : Registry()) {
    if (client->scope() && client->scope()->credential_id == credential_id) {
      clients.push_back(client);
    }
  }
  return clients;
}

void MarkOffscreen(base::DictValue* info) {
  if (info && IsOffscreenTarget(info->FindString("targetId"))) {
    info->Set("ardiaOffscreen", true);
  }
}

}

PluginWheelTicket::PluginWheelTicket(content::WebContents* contents,
                                     WheelSlot slot)
    : content::WebContentsObserver(contents), slot_(std::move(slot)) {}

PluginWheelTicket::~PluginWheelTicket() {
  Free();
}

bool PluginWheelTicket::Forward() {
  return state_.Forward();
}

void PluginWheelTicket::Acked(bool phase_end) {
  if (state_.Acked(phase_end)) {
    Free();
  }
}

void PluginWheelTicket::WidgetGone() {
  if (state_.Gone()) {
    Free();
  }
}

bool PluginWheelTicket::Expire() {
  if (!state_.Expire()) {
    return false;
  }
  Free();
  return true;
}

void PluginWheelTicket::Abandon() {
  if (state_.Abandon()) {
    Free();
  }
}

void PluginWheelTicket::WebContentsDestroyed() {
  Observe(nullptr);
  if (state_.Gone()) {
    Free();
  }
}

void PluginWheelTicket::Free() {
  if (!freed_) {
    freed_ = true;
    PluginWheelSlots().Release(slot_);
  }
}

void TokenClient::AbandonWheels(const std::string& session) {
  auto node = wheel_tickets_.extract(session);
  if (node.empty()) {
    return;
  }
  for (const scoped_refptr<PluginWheelTicket>& ticket : node.mapped()) {
    ticket->Abandon();
  }
}

void TokenClient::ForgetWheel(const std::string& session,
                              const PluginWheelTicket* ticket) {
  auto it = wheel_tickets_.find(session);
  if (it == wheel_tickets_.end()) {
    return;
  }
  std::erase_if(it->second, [&](const scoped_refptr<PluginWheelTicket>& held) {
    return held.get() == ticket;
  });
  if (it->second.empty()) {
    wheel_tickets_.erase(it);
  }
}

CommandDomain DomainOf(std::string_view method) {
  const std::string_view domain = method.substr(0, method.find('.'));
  for (const auto& [name, counted] : kCountedDomains) {
    if (name == domain) {
      return counted;
    }
  }
  return CommandDomain::kOther;
}

void CountCommand(CommandDomain domain) {
  int& count = CommandCounts()[static_cast<size_t>(domain)];
  if (count < std::numeric_limits<int>::max()) {
    ++count;
  }
}

bool IsOffscreenTarget(const std::string* target_id) {
  content::DevToolsAgentHost* host =
      target_id ? content::ArdiaDevToolsAgentHostForId(*target_id) : nullptr;
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  return contents && ardiacore::InAutomationWindow(contents);
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

TokenClient::TokenClient(content::DevToolsAgentHostClient* client,
                         content::DevToolsAgentHost* host,
                         TokenKind kind,
                         std::optional<PluginScope> scope)
    : client_(client),
      root_host_(host),
      kind_(kind),
      scope_(std::move(scope)) {
  CHECK_EQ(kind_ == TokenKind::kPlugin, scope_.has_value());
  Registry()[client_] = this;
  if (kind_ == TokenKind::kPlugin) {
    WatchTab(std::string());
  }
}

void TokenClient::Revoke() {
  ReturnAllActions();
  revoked_ = true;
  wedged_ = true;
  if (scope_) {
    ReleasePluginTabVisibleHolds(scope_->credential_id);
  }
  if (closer_) {
    closer_.Run(true);
  }
}

void TokenClient::SetCloser(
    base::RepeatingCallback<void(bool drop_queued)> close) {
  closer_ = std::move(close);
}

void TokenClient::SetChannel(
    base::RepeatingCallback<void(std::string)> to_browser,
    base::RepeatingCallback<void(std::string)> to_client) {
  to_browser_ = std::move(to_browser);
  to_client_ = std::move(to_client);
}

bool TokenClient::MayAttachToURL(const GURL& url, bool is_webui) {
  return kind_ == TokenKind::kCli || (!is_webui && IsWebUrl(url));
}

bool TokenClient::MayAttachToRenderFrameHost(content::RenderFrameHost* frame) {
  return kind_ == TokenKind::kCli || PluginMayAttachToFrame(*scope_, frame);
}

bool TokenClient::MayReadLocalFiles() {
  return kind_ == TokenKind::kCli;
}

bool TokenClient::MayWriteLocalFiles() {
  return kind_ == TokenKind::kCli;
}

TokenClient::~TokenClient() {
  for (auto& [session, tickets] : wheel_tickets_) {
    for (const scoped_refptr<PluginWheelTicket>& ticket : tickets) {
      ticket->Abandon();
    }
  }
  ReturnAllActions();
  Registry().erase(client_);
  if (kind_ == TokenKind::kPlugin) {
    ActLeaseSessionsLeft(scope_->credential_id);
  }
  ForgetFilePickerAnswers(this);
  ReleaseCliOwnedTargets(this);
}

bool TokenClient::FilterCommand(std::string& message, std::string* reply) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    *reply = ErrorReply(0, std::string(), kParseError,
                        refusal::kNotJsonObject);
    return false;
  }
  base::DictValue& command = parsed->GetDict();
  const std::string* session_id = command.FindString("sessionId");
  const std::string session = session_id ? *session_id : std::string();
  std::optional<int> id = command.FindInt("id");
  const std::string* method = command.FindString("method");
  if (!id || !method || (command.Find("sessionId") && !session_id)) {
    *reply = ErrorReply(id.value_or(0), session, kInvalidRequest,
                        refusal::kNeedsIdAndMethod);
    return false;
  }
  if (session_id && !targets_.contains(session)) {
    *reply = ErrorReply(*id, std::string(), kInvalidRequest,
                        refusal::kNoAttachedSession);
    return false;
  }
  if (command.Find("params") && !command.FindDict("params")) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        refusal::kParamsNotObject);
    return false;
  }
  if (wedged_ || revoked_) {
    *reply = ErrorReply(*id, session, kRefused,
                        refusal::kClosing);
    return false;
  }
  if (draining_) {
    *reply = ErrorReply(
        *id, session, kRefused,
        std::string(refusal::kOutOfScope));
    return false;
  }
  const std::pair<std::string, int> key(session, *id);
  if (outstanding_.contains(key)) {
    *reply = ErrorReply(*id, session, kInvalidRequest,
                        refusal::kDuplicateId);
    return false;
  }
  if (outstanding_.size() >= kMaxPending) {
    *reply = ErrorReply(*id, session, kRefused,
                        refusal::kTooManyPending);
    wedged_ = true;
    return false;
  }
  base::DictValue& params = *command.EnsureDict("params");
  int64_t grant = 0;
  if (kind_ == TokenKind::kPlugin &&
      !PluginCommandAllowed(*id, session, *method, params, reply, &grant)) {
    return false;
  }
  if (*method == kAnswerFilePicker) {
    return AnswerFilePickerCommand(*id, session, &params, reply);
  }
  if (*method == kDispatchClick ||
      (kind_ == TokenKind::kPlugin && *method == "Input.dispatchMouseEvent")) {
    outstanding_[key] = *method;
    return DispatchPointerCommand(*id, session, *method, params, grant,
                                  reply);
  }
  if (*method == "IO.read") {
    const std::optional<int> size = params.FindInt("size");
    if (size && *size > kMaxIoReadBytes) {
      params.Set("size", kMaxIoReadBytes);
    }
  }
  NoteCommand(*method, session, &params);
  outstanding_[key] = NeedsResponse(*method) ? *method : std::string();
  message = base::WriteJson(command).value_or(std::string());
  if (kind_ == TokenKind::kPlugin) {
    NoteDispatchingGrant(session, grant);
  }
  return !message.empty();
}

bool TokenClient::AnswerFilePickerCommand(int id,
                                          const std::string& session,
                                          const base::DictValue* params,
                                          std::string* reply) {
  CountCommand(CommandDomain::kOther);
  auto target = targets_.find(session);
  content::DevToolsAgentHost* host =
      target == targets_.end()
          ? nullptr
          : content::ArdiaDevToolsAgentHostForId(target->second);
  const base::DictValue empty;
  const std::string refusal = ArmFilePickerAnswer(
      host ? host->GetWebContents() : nullptr, params ? *params : empty, this);
  if (!refusal.empty()) {
    *reply = ErrorReply(id, session, kInvalidRequest,
                        base::StrCat({refusal::kPrefix, kAnswerFilePicker, " ",
                                      refusal, refusal::kCantBeAnsweredSuffix}));
    return false;
  }
  base::DictValue answer;
  answer.Set("id", id);
  if (!session.empty()) {
    answer.Set("sessionId", session);
  }
  answer.Set("result", base::DictValue());
  *reply = base::WriteJson(answer).value_or("{}");
  return false;
}

bool TokenClient::DispatchPointerCommand(int id,
                                         const std::string& session,
                                         const std::string& method,
                                         const base::DictValue& params,
                                         int64_t grant,
                                         std::string* reply) {
  CountCommand(CommandDomain::kInput);
  content::DevToolsAgentHost* host = HostOf(session);
  content::ArdiaPointer pointer;
  std::string refusal;
  if (method == kDispatchClick) {
    PluginClickParams click;
    refusal = PluginClickRefusal(ToPluginParams(params), &click);
    pointer.kind = content::ArdiaPointer::Kind::kClick;
    pointer.x = click.x;
    pointer.y = click.y;
    pointer.button = click.button;
    pointer.click_count = click.click_count;
    pointer.modifiers = click.modifiers;
  } else {
    PluginMouseParams mouse;
    refusal = PluginMouseRefusal(ToPluginParams(params), &mouse);
    pointer.kind = mouse.type == "mouseWheel"
                       ? content::ArdiaPointer::Kind::kWheel
                       : content::ArdiaPointer::Kind::kMove;
    pointer.x = mouse.x;
    pointer.y = mouse.y;
    pointer.modifiers = mouse.modifiers;
    pointer.delta_x = mouse.delta_x.value_or(0);
    pointer.delta_y = mouse.delta_y.value_or(0);
  }
  if (!host || !refusal.empty()) {
    outstanding_.erase({session, id});
    SettleCommandState();
    *reply = ErrorReply(
        id, session, kInvalidRequest,
        base::StrCat({refusal::kPrefix, method, " ",
                      refusal.empty() ? std::string("without a page")
                                      : refusal,
                      refusal::kCantBeSentSuffix}));
    return false;
  }
  pointer.epoch = content::ArdiaPageEpoch(host);
  pointer.grant = grant;
  pointer.plugin = kind_ == TokenKind::kPlugin;
  const uint64_t run = ++next_pointer_run_;
  scoped_refptr<PluginWheelTicket> ticket;
  if (kind_ == TokenKind::kPlugin &&
      pointer.kind == content::ArdiaPointer::Kind::kWheel) {
    content::WebContents* contents = host->GetWebContents();
    WheelSlot slot{scope_->credential_id, contents};
    if (!PluginWheelSlots().Take(slot)) {
      outstanding_.erase({session, id});
      SettleCommandState();
      ++PluginTotalsSoFar().busy;
      *reply = ErrorReply(id, session, kRefused, refusal::kBusy);
      return false;
    }
    ticket = base::MakeRefCounted<PluginWheelTicket>(contents, std::move(slot));
    pointer.wheel_ticket = ticket;
    wheel_tickets_[session].push_back(ticket);
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<TokenClient> self,
               scoped_refptr<PluginWheelTicket> ticket, std::string session,
               int id, uint64_t run) {
              if (ticket->Expire() && self) {
                self->ForgetWheel(session, ticket.get());
                self->FinishPointer(id, session, run, refusal::kNotDelivered);
              }
            },
            weak_factory_.GetWeakPtr(), ticket, session, id, run),
        kPluginWheelDeadline);
  }
  pointer_runs_[{session, id}] = run;
  auto dispatch = base::BindOnce(
      [](base::WeakPtr<TokenClient> self,
         scoped_refptr<content::DevToolsAgentHost> host, std::string session,
         int id, uint64_t run, content::ArdiaPointer pointer,
         scoped_refptr<PluginWheelTicket> ticket) {
        if (!self || self->revoked_) {
          if (ticket) {
            ticket->Abandon();
          }
          return;
        }
        content::ArdiaDispatchPointer(
            host.get(), self->client_, session, pointer,
            base::BindOnce(
                [](base::WeakPtr<TokenClient> self,
                   scoped_refptr<PluginWheelTicket> ticket, std::string session,
                   int id, uint64_t run, std::string error) {
                  if (ticket) {
                    ticket->Abandon();
                  }
                  if (!self) {
                    return;
                  }
                  if (ticket) {
                    self->ForgetWheel(session, ticket.get());
                  }
                  self->FinishPointer(id, session, run, std::move(error));
                },
                self, ticket, session, id, run));
      },
      weak_factory_.GetWeakPtr(), base::WrapRefCounted(host), session, id, run,
      pointer, ticket);
  if (kind_ == TokenKind::kPlugin && CliPluginInputHold()) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, std::move(dispatch), kHeldPluginInput);
  } else {
    std::move(dispatch).Run();
  }
  return false;
}

void TokenClient::FinishPointer(int id,
                                      const std::string& session,
                                      uint64_t run,
                                      std::string error) {
  auto owner = pointer_runs_.find({session, id});
  if (owner == pointer_runs_.end() || owner->second != run) {
    return;
  }
  pointer_runs_.erase(owner);
  const bool waiting = outstanding_.erase({session, id}) > 0;
  SettleCommandState();
  if (!waiting || !to_client_) {
    return;
  }
  if (!error.empty()) {
    if (error == refusal::kBusy) {
      ++PluginTotalsSoFar().busy;
    }
    to_client_.Run(ErrorReply(id, session, kRefused, error));
    return;
  }
  base::DictValue answer;
  answer.Set("id", id);
  if (!session.empty()) {
    answer.Set("sessionId", session);
  }
  answer.Set("result", base::DictValue());
  to_client_.Run(base::WriteJson(answer).value_or("{}"));
}

bool TokenClient::ShouldClose() const {
  return wedged_;
}

void TokenClient::NoteCommand(const std::string& method,
                              const std::string& session,
                              const base::DictValue* params) {
  CountCommand(DomainOf(method));
  if (method != "Emulation.setDeviceMetricsOverride") {
    return;
  }
  auto target = targets_.find(session);
  if (target != targets_.end()) {
    ClaimCliOwnedTarget(target->second, this);
  }
}

bool TokenClient::FilterResponse(const std::string& method,
                                 std::string& message) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(message, base::JSON_PARSE_RFC);
  base::DictValue* result =
      parsed && parsed->is_dict() ? parsed->GetDict().FindDict("result")
                                  : nullptr;
  if (!result) {
    return true;
  }
  const std::string* session_id = parsed->GetDict().FindString("sessionId");
  const std::string session = session_id ? *session_id : std::string();
  if (method == "Target.createTarget") {
    if (const std::string* target_id = result->FindString("targetId")) {
      NoteCliOwnedTarget(*target_id, this);
    }
    return true;
  }
  if (method == "Target.getTargets") {
    base::ListValue* infos = result->FindList("targetInfos");
    if (!infos) {
      return true;
    }
    if (kind_ == TokenKind::kPlugin) {
      infos->EraseIf([&](const base::Value& info) {
        return !info.is_dict() ||
               !PluginMayAttachToTargetId(*scope_,
                                          info.GetDict().FindString("targetId"));
      });
    }
    for (base::Value& info : *infos) {
      MarkOffscreen(info.GetIfDict());
      if (kind_ == TokenKind::kPlugin) {
        ScrubPluginTargetInfo(*scope_, info.GetIfDict());
        if (const std::string* target_id = info.GetDict().FindString("targetId")) {
          told_targets_.insert(*target_id);
        }
      }
    }
  } else {
    base::DictValue* info = result->FindDict("targetInfo");
    MarkOffscreen(info);
    const std::string* target_id = info ? info->FindString("targetId") : nullptr;
    if (kind_ == TokenKind::kPlugin && target_id) {
      if (!PluginMayAttachToTargetId(*scope_, target_id)) {
        message = ErrorReply(
            parsed->GetDict().FindInt("id").value_or(0), session, kRefused,
            std::string(refusal::kOutOfScope));
        return true;
      }
      told_targets_.insert(*target_id);
      ScrubPluginTargetInfo(*scope_, info);
    }
  }
  std::optional<std::string> annotated = base::WriteJson(*parsed);
  if (annotated) {
    message = std::move(*annotated);
  }
  return true;
}

}

std::unique_ptr<ArdiaDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host,
    TokenKind kind,
    std::optional<PluginScope> scope) {
  if ((kind == TokenKind::kPlugin) != scope.has_value() ||
      (scope && !PluginMayConnectTo(*scope, host))) {
    return nullptr;
  }
  return std::make_unique<cli_token_policy_internal::TokenClient>(
      client, host, kind, std::move(scope));
}

std::optional<TokenKind> TokenClientKind(
    content::DevToolsAgentHostClient* root_client) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end()) {
    return std::nullopt;
  }
  return it->second->kind();
}

bool IsTokenClient(content::DevToolsAgentHostClient* root_client) {
  return TokenClientKind(root_client).has_value();
}

bool TokenClientMayAttach(content::DevToolsAgentHostClient* root_client,
                          content::DevToolsAgentHost* host) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end() ||
      it->second->kind() == TokenKind::kCli) {
    return true;
  }
  return host == it->second->root_host() ||
         cli_token_policy_internal::PluginTargetInScope(*it->second->scope(),
                                                        host);
}

bool TokenClientMayInput(content::DevToolsAgentHostClient* root_client,
                         content::RenderFrameHost* frame) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end() ||
      it->second->kind() == TokenKind::kCli) {
    return true;
  }
  return it->second->MayInputTo(frame);
}

ArdiaSessionInput TokenClientSessionMayInput(
    content::DevToolsAgentHostClient* root_client,
    const std::string& session,
    int64_t grant,
    bool delivering) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end() ||
      it->second->kind() == TokenKind::kCli) {
    return ArdiaSessionInput::kAllowed;
  }
  return it->second->MaySessionInput(session, grant, delivering);
}

int64_t TokenClientInputGrant(content::DevToolsAgentHostClient* root_client,
                              const std::string& session) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end() ||
      it->second->kind() == TokenKind::kCli) {
    return 0;
  }
  return it->second->InputGrant(session);
}

void InstallTokenClientInputHooks() {
  g_ardia_devtools_may_input = &TokenClientMayInput;
  g_ardia_devtools_session_may_input = &TokenClientSessionMayInput;
  g_ardia_devtools_input_grant = &TokenClientInputGrant;
}

bool TokenClientRendererUntrusted(content::DevToolsAgentHostClient* root_client) {
  return TokenClientKind(root_client) == TokenKind::kPlugin;
}

void CloseTokenClientsOf(const std::string& credential_id) {
  ReleaseActLeasesOf(credential_id);
  for (cli_token_policy_internal::TokenClient* client :
       cli_token_policy_internal::ClientsOf(credential_id)) {
    client->Revoke();
  }
}

std::optional<std::string> PluginCredentialOf(
    content::DevToolsAgentHostClient* root_client) {
  auto it = cli_token_policy_internal::Registry().find(root_client);
  if (it == cli_token_policy_internal::Registry().end() ||
      it->second->kind() != TokenKind::kPlugin) {
    return std::nullopt;
  }
  return it->second->scope()->credential_id;
}

bool PluginTabInScope(const std::string& credential_id,
                      content::WebContents* contents) {
  if (!contents || contents->IsBeingDestroyed()) {
    return false;
  }
  std::vector<cli_token_policy_internal::TokenClient*> clients =
      cli_token_policy_internal::ClientsOf(credential_id);
  if (clients.empty()) {
    return false;
  }
  scoped_refptr<content::DevToolsAgentHost> page =
      content::DevToolsAgentHost::GetOrCreateFor(contents);
  return cli_token_policy_internal::PluginTargetInScope(
      *clients.front()->scope(), page.get());
}

PluginTotals& PluginTotalsSoFar() {
  static PluginTotals totals;
  return totals;
}

base::DictValue TokenCommandsByDomain() {
  base::DictValue counts;
  for (size_t i = 0; i < cli_token_policy_internal::kDomainNames.size(); ++i) {
    counts.Set(cli_token_policy_internal::kDomainNames[i],
               cli_token_policy_internal::CommandCounts()[i]);
  }
  return counts;
}

}
