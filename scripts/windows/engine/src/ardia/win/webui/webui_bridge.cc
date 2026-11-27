#include "ardia/win/webui/webui_bridge.h"

#include <string>
#include <utility>

#include "ardia/win/webui/webui_host_view.h"
#include "base/functional/bind.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"

namespace ardia_win::webui {

namespace {

constexpr size_t kRequestIdLimit = 256;

std::string Text(const base::DictValue& value, std::string_view key) {
  const std::string* found = value.FindString(key);
  return found ? *found : std::string();
}

}

ShellBridge::ShellBridge(content::WebContents* shell,
                         base::WeakPtr<ShellHostView> host)
    : content::WebContentsObserver(shell), host_(std::move(host)) {}

ShellBridge::~ShellBridge() {
  if (host_) {
    host_->ClearHandler(this);
  }
}

bool ShellBridge::Live() {
  return host_ && IsJavascriptAllowed() && host_->Trusted(web_ui()) &&
         host_->OwnsHandler(this, generation_);
}

void ShellBridge::Send(std::string_view module,
                       std::string_view event,
                       const base::Value& payload) {
  if (!Live()) {
    return;
  }
  CallJavascriptFunction("__ardiaEvent", base::Value(module), base::Value(event),
                         payload);
}

void ShellBridge::Reply(const std::string& id,
                        bool success,
                        base::Value response) {
  if (!Live()) {
    return;
  }
  CallJavascriptFunction("__ardiaReply", base::Value(id), base::Value(success),
                         response);
}

void ShellBridge::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "ardiaRequest",
      base::BindRepeating(&ShellBridge::Request, base::Unretained(this)));
}

void ShellBridge::Activate() {
  if (!host_ || !host_->Trusted(web_ui())) {
    return;
  }
  generation_ = host_->SetHandler(this, web_ui());
}

void ShellBridge::PrimaryPageChanged(content::Page& page) {
  if (&page.GetMainDocument() == web_ui()->GetRenderFrameHost()) {
    Activate();
  }
}

void ShellBridge::PrimaryMainFrameRenderProcessGone(
    base::TerminationStatus status) {
  weak_factory_.InvalidateWeakPtrs();
  if (host_) {
    host_->ClearHandler(this);
  }
}

void ShellBridge::OnJavascriptDisallowed() {
  weak_factory_.InvalidateWeakPtrs();
  if (host_ && !host_->OwnsHandler(this, generation_)) {
    host_->ClearHandler(this);
  }
}

void ShellBridge::Request(const base::ListValue& arguments) {
  CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
  if (!host_ || !host_->Trusted(web_ui()) || arguments.size() != 3 ||
      !arguments[0].is_string() || !arguments[1].is_string() ||
      !arguments[2].is_dict()) {
    return;
  }
  if (!host_->OwnsHandler(this, generation_)) {
    Activate();
  }
  if (!host_ || !host_->OwnsHandler(this, generation_)) {
    return;
  }
  const std::string id = arguments[0].GetString();
  if (id.empty() || id.size() > kRequestIdLimit) {
    return;
  }
  AllowJavascript();
  ShellHostView* host = host_.get();
  host->NoteRequest(weak_factory_.GetWeakPtr(), generation_);
  const base::DictValue& args = arguments[2].GetDict();
  auto done = base::BindOnce(&ShellHostView::DeliverReply, host->GetWeakPtr(),
                             weak_factory_.GetWeakPtr(), generation_, id);
  if (arguments[1].GetString() == "engine.call") {
    return host->EngineCall(Text(args, "name"), Text(args, "profile"),
                            args.Find("args"), std::move(done));
  }
  if (arguments[1].GetString() != "host.invoke") {
    return std::move(done).Run(
        false, base::Value("Unknown native transport operation"));
  }
  const base::DictValue* payload = args.FindDict("args");
  if (!payload) {
    return std::move(done).Run(false,
                               base::Value("Host arguments must be an object"));
  }
  host->Invoke(Text(args, "method"), *payload, std::move(done));
}

}
