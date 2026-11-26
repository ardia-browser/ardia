#include "ardia/mac/ac_mac_shell_bridge.h"

#include <optional>
#include <string>
#include <utility>

#include "ardia/mac/ac_mac_popover.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/page.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_mac {

namespace {

constexpr size_t kRequestIdLimit = 256;

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

PopoverBridge::PopoverBridge(content::WebContents* contents,
                             base::WeakPtr<ShellHostView> host)
    : contents_(contents), host_(std::move(host)) {}

PopoverBridge::~PopoverBridge() = default;

void PopoverBridge::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "ardiaRequest",
      base::BindRepeating(&PopoverBridge::Request, base::Unretained(this)));
  if (host_ && host_->popovers()) {
    host_->popovers()->Connect(
        contents_, base::BindRepeating(&PopoverBridge::Deliver,
                                       weak_factory_.GetWeakPtr()));
  }
}

void PopoverBridge::Deliver(std::string_view event, const base::Value& payload) {
  if (!Trusted()) {
    return;
  }
  AllowJavascript();
  CallJavascriptFunction("__ardiaEvent", base::Value("ArdiaPopover"),
                         base::Value(event), payload);
}

bool PopoverBridge::Trusted() {
  if (!host_ || !host_->popovers() || !contents_ ||
      !host_->popovers()->Owns(contents_)) {
    return false;
  }
  content::RenderFrameHost* frame = contents_->GetPrimaryMainFrame();
  return frame && frame->IsRenderFrameLive() &&
         web_ui()->GetRenderFrameHost() == frame &&
         frame->GetWebUI() == web_ui() &&
         frame->GetLastCommittedOrigin() ==
             url::Origin::Create(GURL("chrome://ardia/"));
}

void PopoverBridge::Reply(const std::string& id,
                          bool success,
                          base::Value response) {
  if (!Trusted()) {
    return;
  }
  AllowJavascript();
  CallJavascriptFunction("__ardiaReply", base::Value(id), base::Value(success),
                         response);
}

void PopoverBridge::Request(const base::ListValue& arguments) {
  CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
  if (!Trusted() || arguments.size() != 3 || !arguments[0].is_string() ||
      !arguments[1].is_string() || !arguments[2].is_dict()) {
    return;
  }
  const std::string id = arguments[0].GetString();
  if (id.empty() || id.size() > kRequestIdLimit) {
    return;
  }
  const base::DictValue& args = arguments[2].GetDict();
  const base::DictValue* payload = args.FindDict("args");
  const std::string method = Text(args, "method");
  if (arguments[1].GetString() != "host.invoke" || !payload) {
    return Reply(id, false, base::Value("Popovers may only invoke the host"));
  }
  const std::optional<std::string> key = host_->popovers()->IdFor(contents_);
  if (!key) {
    return;
  }
  ShellHostView* host = host_.get();
  base::DictValue data;
  data.Set("id", *key);
  data.Set("windowId", host->window_id());
  if (method == "shell.popover.close") {
    data.Set("reason", "closed");
    Reply(id, true, base::Value());
    host->popovers()->Dismiss(*key, popover::Event::kClose);
    host->EmitShellEvent("shell.popoverDismissed", base::Value(std::move(data)));
    return;
  }
  if (method == "shell.popover.props") {
    std::optional<base::Value> props = host->popovers()->PropsFor(contents_);
    return Reply(id, true, props ? std::move(*props) : base::Value());
  }
  if (method == "shell.popover.message") {
    const base::Value* message = payload->Find("message");
    const std::optional<std::string> serialized =
        message ? base::WriteJson(*message) : std::optional<std::string>("null");
    if (!popover::MessageFits(serialized ? std::optional<std::size_t>(serialized->size())
                                         : std::nullopt)) {
      return Reply(id, false, base::Value("The popover message must serialize within 64 KiB"));
    }
    data.Set("message", message ? message->Clone() : base::Value());
    host->EmitShellEvent("shell.popoverMessage", base::Value(std::move(data)));
    return Reply(id, true, base::Value());
  }
  Reply(id, false, base::Value("Popovers may only close, read their props or message the shell"));
}

}
