#include "ardia/win/page_links.h"

#include <map>
#include <string>
#include <string_view>
#include <utility>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/main.h"
#include "ardia/win/page_links_internal.h"
#include "ardia/win/page_links_script.h"
#include "ardia/win/tab_calls.h"
#include "ardia/win/tab_state.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/task/single_thread_task_runner.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia_win {

using namespace links;

namespace {

constexpr size_t kReportsKeptForTest = 8;

}

void PageLinks::FrameCommitted(content::RenderFrameHost* frame,
                               bool restored) {
  if (!host_) {
    Attach();
  } else if (!script_id_ && !registering_ && !enabling_) {
    Register();
  }
  if (restored) {
    for (const auto& entry : contexts_) {
      SendConfig(entry.first);
    }
  }
}

void PageLinks::ReattachForTest() {
  if (!host_) {
    return;
  }
  scoped_refptr<content::DevToolsAgentHost> host = host_;
  host->DetachClient(this);
  AgentHostClosed(host.get());
}

void PageLinks::Note(std::string_view what, bool failed) {
  if (!ardiacore::TestInstance()) {
    return;
  }
  NoteForTest(std::string(what) + " " + Tag() + (failed ? " (error)" : ""));
}

void PageLinks::ResetSession() {
  host_ = nullptr;
  contexts_.clear();
  script_id_.reset();
  replacing_.reset();
  enabling_ = false;
  registering_ = false;
  std::map<int, Answer> pending = std::move(pending_);
  pending_.clear();
  for (auto& entry : pending) {
    std::move(entry.second).Run(std::nullopt);
  }
}

void PageLinks::Recover() {
  if (!host_ || recovering_) {
    return;
  }
  recovering_ = true;
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&PageLinks::RecoverNow,
                                weak_factory_.GetWeakPtr(), session_));
}

void PageLinks::RecoverNow(int session) {
  recovering_ = false;
  if (session != session_ || !host_ || GetWebContents().IsBeingDestroyed()) {
    return;
  }
  Note("links registration failed, dropping the session");
  scoped_refptr<content::DevToolsAgentHost> host = host_;
  ResetSession();
  host->DetachClient(this);
  if (!reattach_spent_) {
    reattach_spent_ = true;
    Attach();
  }
}

void PageLinks::ScheduleReattach() {
  if (reattach_spent_ || GetWebContents().IsBeingDestroyed()) {
    return;
  }
  reattach_spent_ = true;
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(&PageLinks::Reattach, weak_factory_.GetWeakPtr()));
}

void PageLinks::Reattach() {
  if (!host_ && !GetWebContents().IsBeingDestroyed()) {
    Attach();
  }
}

bool PageLinks::Attach() {
  if (host_) {
    return true;
  }
  if (GetWebContents().IsBeingDestroyed()) {
    return false;
  }
  Note("links attach");
  host_ = content::DevToolsAgentHost::GetOrCreateFor(&GetWebContents());
  if (!host_ || !host_->AttachClient(this)) {
    Note("links attach refused");
    host_ = nullptr;
    return false;
  }
  ++session_;
  UnmarkEngineDevTools(&GetWebContents());
  contexts_.clear();
  Register();
  Note("links attached");
  return true;
}

std::string PageLinks::Tag() {
  TabState* tab = TabState::FromWebContents(&GetWebContents());
  return tab ? tab->key() : std::string("(no tab)");
}

void PageLinks::Register() {
  script_id_.reset();
  replacing_.reset();
  enabling_ = true;
  registering_ = true;
  Call("Page.enable", base::DictValue(), base::DoNothing());
  Call("Runtime.enable", base::DictValue(),
       base::BindOnce(&PageLinks::RuntimeEnabled, weak_factory_.GetWeakPtr()));
}

void PageLinks::RuntimeEnabled(std::optional<base::DictValue> answer) {
  Note("links runtime enabled", !answer);
  if (!host_) {
    return;
  }
  enabling_ = false;
  if (!answer) {
    registering_ = false;
    Recover();
    return;
  }
  base::DictValue binding;
  binding.Set("name", kBinding);
  binding.Set("executionContextName", kWorld);
  Call("Runtime.addBinding", std::move(binding), base::DoNothing());
  AddScript(true);
}

void PageLinks::AddScript(bool run_now) {
  base::DictValue params;
  params.Set("source", SourceForNewDocuments());
  params.Set("worldName", kWorld);
  params.Set("runImmediately", run_now);
  registered_config_ = ConfigGeneration();
  Call("Page.addScriptToEvaluateOnNewDocument", std::move(params),
       base::BindOnce(&PageLinks::ScriptAdded, weak_factory_.GetWeakPtr()));
}

void PageLinks::ScriptAdded(std::optional<base::DictValue> added) {
  Note("links script added", !added);
  if (!host_) {
    return;
  }
  registering_ = false;
  const std::string* id = added ? added->FindString("identifier") : nullptr;
  std::optional<std::string> replaced = std::move(replacing_);
  replacing_.reset();
  if (!id) {
    script_id_ = std::move(replaced);
    Recover();
    return;
  }
  reattach_spent_ = false;
  script_id_ = *id;
  if (replaced) {
    base::DictValue old;
    old.Set("identifier", *replaced);
    Call("Page.removeScriptToEvaluateOnNewDocument", std::move(old),
         base::DoNothing());
  }
  if (registered_config_ != ConfigGeneration()) {
    PushConfig();
  }
}

std::string PageLinks::SourceForNewDocuments() {
  return std::string(kLinkScript) +
         "\nglobalThis.ardiaPeek && globalThis.ardiaPeek.config(" +
         ConfigJson() + ");";
}

content::RenderFrameHost* PageLinks::ActiveFrameWithToken(
    const std::string& token) {
  content::RenderFrameHost* found = nullptr;
  GetWebContents().ForEachRenderFrameHost(
      [&token, &found](content::RenderFrameHost* frame) {
        if (!found && frame->IsActive() &&
            frame->GetDevToolsFrameToken().ToString() == token) {
          found = frame;
        }
      });
  return found;
}

void PageLinks::ContextCreated(const base::DictValue& params) {
  const base::DictValue* context = params.FindDict("context");
  std::optional<int> id = context ? context->FindInt("id") : std::nullopt;
  const std::string* name = context ? context->FindString("name") : nullptr;
  if (!id || !name || *name != kWorld) {
    return;
  }
  const base::DictValue* aux = context->FindDict("auxData");
  const std::string* frame_id = aux ? aux->FindString("frameId") : nullptr;
  if (!frame_id) {
    NoteReportForTest("context", "", "no frameId");
    return;
  }
  contexts_[*id] = Context{*frame_id};
  SendConfig(*id);
}

void PageLinks::NoteReportForTest(const std::string& kind,
                                  const std::string& url,
                                  const std::string& outcome) {
  if (!ardiacore::TestInstance()) {
    return;
  }
  base::DictValue report;
  report.Set("kind", kind);
  report.Set("url", url);
  report.Set("outcome", outcome);
  report.Set("seq", ++report_seq_);
  reports_for_test_.push_back(std::move(report));
  if (reports_for_test_.size() > kReportsKeptForTest) {
    reports_for_test_.erase(reports_for_test_.begin());
  }
}

base::ListValue PageLinks::ReportsForTest() const {
  base::ListValue reports;
  for (const base::DictValue& report : reports_for_test_) {
    reports.Append(report.Clone());
  }
  return reports;
}

void PageLinks::Call(const std::string& method,
                     base::DictValue params,
                     Answer answer) {
  if (!Attach()) {
    std::move(answer).Run(std::nullopt);
    return;
  }
  const int id = next_id_++;
  base::DictValue message;
  message.Set("id", id);
  message.Set("method", method);
  message.Set("params", std::move(params));
  std::optional<std::string> json = base::WriteJson(message);
  if (!json) {
    std::move(answer).Run(std::nullopt);
    return;
  }
  pending_[id] = std::move(answer);
  scoped_refptr<content::DevToolsAgentHost> host = host_;
  host->DispatchProtocolMessage(this, base::as_byte_span(*json));
}

void PageLinks::Evaluate(int context, const std::string& expression) {
  base::DictValue params;
  params.Set("expression", expression);
  params.Set("contextId", context);
  params.Set("silent", true);
  Call("Runtime.evaluate", std::move(params), base::DoNothing());
}

void PageLinks::DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                                        base::span<const uint8_t> message) {
  const std::string_view text = base::as_string_view(message);
  if (text.starts_with("{\"method\":\"Runtime.console") ||
      text.starts_with("{\"method\":\"Runtime.exception") ||
      text.starts_with("{\"method\":\"Page.")) {
    return;
  }
  std::optional<base::DictValue> parsed = base::JSONReader::ReadDict(
      base::as_string_view(message), base::JSON_PARSE_CHROMIUM_EXTENSIONS);
  if (!parsed) {
    return;
  }
  if (std::optional<int> id = parsed->FindInt("id")) {
    auto it = pending_.find(*id);
    if (it == pending_.end()) {
      return;
    }
    Answer answer = std::move(it->second);
    pending_.erase(it);
    if (parsed->FindDict("error")) {
      std::move(answer).Run(std::nullopt);
      return;
    }
    base::DictValue* result = parsed->FindDict("result");
    std::move(answer).Run(result ? std::move(*result) : base::DictValue());
    return;
  }
  const std::string* method = parsed->FindString("method");
  const base::DictValue* params = parsed->FindDict("params");
  if (!method || !params) {
    return;
  }
  if (*method == "Runtime.executionContextCreated") {
    ContextCreated(*params);
    return;
  }
  if (*method == "Runtime.executionContextDestroyed") {
    if (std::optional<int> id = params->FindInt("executionContextId")) {
      contexts_.erase(*id);
    }
    return;
  }
  if (*method == "Runtime.executionContextsCleared") {
    contexts_.clear();
    return;
  }
  if (*method != "Runtime.bindingCalled") {
    return;
  }
  const std::string* name = params->FindString("name");
  const std::string* payload = params->FindString("payload");
  std::optional<int> context = params->FindInt("executionContextId");
  if (!name || *name != kBinding || !payload || !context) {
    return;
  }
  Heard(*context, *payload);
}

void PageLinks::AgentHostClosed(content::DevToolsAgentHost* agent_host) {
  Note("links session closed");
  ResetSession();
  ScheduleReattach();
}

bool PageLinks::MayAttachToURL(const GURL& url, bool is_webui) {
  return true;
}

bool PageLinks::IsTrusted() {
  return true;
}

bool PageLinks::MayReadLocalFiles() {
  return false;
}

void PageLinks::SendConfig(int context) {
  Evaluate(context, "globalThis.ardiaPeek && globalThis.ardiaPeek.config(" +
                        ConfigJson() + ");");
}

void PageLinks::PushConfig() {
  for (const auto& entry : contexts_) {
    SendConfig(entry.first);
  }
  if (!script_id_ || registering_ ||
      registered_config_ == ConfigGeneration()) {
    return;
  }
  replacing_ = std::move(script_id_);
  script_id_.reset();
  registering_ = true;
  AddScript(false);
}

}
