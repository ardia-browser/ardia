#include "ardia/linux/ui_host/app_bridge_host.h"

#include <optional>
#include <utility>

#include "ardia/linux/ui_host/ui_host_parts.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "mojo/public/cpp/bindings/callback_helpers.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia_linux {

namespace {

std::string ErrorJson(std::string_view message, std::string_view code) {
  base::DictValue reply;
  reply.Set("error", message);
  reply.Set("code", code);
  return base::WriteJson(reply).value_or("{}");
}

std::string RefusalJson() {
  return ErrorJson("This sender can't use Ardia's native bridge",
                   kBridgeSenderRefused);
}

std::optional<base::ListValue> ParseArgs(const std::string& args) {
  std::optional<base::Value> parsed =
      base::JSONReader::Read(args, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_list()) {
    return std::nullopt;
  }
  return std::move(parsed->GetList());
}

}

std::string ReplyJson(const ModuleResult& result) {
  if (!result.has_value()) {
    return ErrorJson(result.error().message, result.error().code);
  }
  base::DictValue reply;
  if (!result.value().is_none()) {
    reply.Set("value", result.value().Clone());
  }
  std::optional<std::string> json = base::WriteJson(reply);
  if (!json) {
    return ErrorJson("the reply can't be sent as JSON", "ERR_LINUX_NATIVE");
  }
  return *json;
}

void RegisterAppBridgeBinder(content::RenderFrameHost& frame,
                             blink::AssociatedInterfaceRegistry& registry) {
  registry.AddInterface<mojom::AppBridge>(base::BindRepeating(
      [](content::RenderFrameHost* frame,
         mojo::PendingAssociatedReceiver<mojom::AppBridge> receiver) {
        AppBridgeHost::Bind(frame, std::move(receiver));
      },
      &frame));
}

DOCUMENT_USER_DATA_KEY_IMPL(AppBridgeHost);

AppBridgeHost::AppBridgeHost(content::RenderFrameHost* frame)
    : content::DocumentUserData<AppBridgeHost>(frame) {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().AddEventSink(this);
  }
}

AppBridgeHost::~AppBridgeHost() {
  if (ModuleRegistry::Exists()) {
    ModuleRegistry::Get().RemoveEventSink(this);
  }
}

void AppBridgeHost::Bind(
    content::RenderFrameHost* frame,
    mojo::PendingAssociatedReceiver<mojom::AppBridge> receiver) {
  if (!IsUiHostDocument(frame)) {
    LOG(WARNING) << "ardia bridge: refused a bind from a frame that isn't "
                    "the UI host's";
    return;
  }
  AppBridgeHost* bridge = AppBridgeHost::GetOrCreateForCurrentDocument(frame);
  bridge->receiver_.reset();
  bridge->client_.reset();
  bridge->receiver_.Bind(std::move(receiver));
}

bool AppBridgeHost::Accepts(std::string_view channel) {
  if (IsUiHostDocument(&render_frame_host()) && ModuleRegistry::Exists()) {
    return true;
  }
  if (!refusal_logged_) {
    refusal_logged_ = true;
    LOG(WARNING) << "ardia bridge: refused " << channel
                 << " from a sender that isn't the UI host";
  }
  return false;
}

void AppBridgeHost::Modules(ModulesCallback callback) {
  if (!Accepts("modules")) {
    std::move(callback).Run("{}");
    return;
  }
  std::move(callback).Run(
      base::WriteJson(ModuleRegistry::Get().Shapes()).value_or("{}"));
}

void AppBridgeHost::CallSync(const std::string& module,
                             const std::string& method,
                             const std::string& args,
                             CallSyncCallback callback) {
  if (!Accepts("callSync")) {
    std::move(callback).Run(RefusalJson());
    return;
  }
  std::optional<base::ListValue> list = ParseArgs(args);
  if (!list) {
    std::move(callback).Run(
        ErrorJson("the arguments aren't a JSON list", "ERR_LINUX_BRIDGE_ARGS"));
    return;
  }
  std::move(callback).Run(
      ReplyJson(ModuleRegistry::Get().CallSync(module, method, *list)));
}

void AppBridgeHost::Call(const std::string& module,
                         const std::string& method,
                         const std::string& args,
                         CallCallback callback) {
  if (!Accepts("call")) {
    std::move(callback).Run(RefusalJson());
    return;
  }
  std::optional<base::ListValue> list = ParseArgs(args);
  if (!list) {
    std::move(callback).Run(
        ErrorJson("the arguments aren't a JSON list", "ERR_LINUX_BRIDGE_ARGS"));
    return;
  }
  CallCallback answered = mojo::WrapCallbackWithDefaultInvokeIfNotRun(
      std::move(callback),
      ErrorJson(module + "." + method + " gave no reply", "ERR_LINUX_NATIVE"));
  ModuleRegistry::Get().Call(
      module, method, std::move(*list),
      base::BindOnce(
          [](CallCallback answered, ModuleResult result) {
            std::move(answered).Run(ReplyJson(result));
          },
          std::move(answered)));
}

void AppBridgeHost::SetClient(
    mojo::PendingAssociatedRemote<mojom::AppBridgeClient> client) {
  if (!Accepts("setClient")) {
    return;
  }
  client_.reset();
  client_.Bind(std::move(client));
}

void AppBridgeHost::OnModuleEvent(std::string_view module,
                                  std::string_view event,
                                  const base::Value& payload) {
  if (!client_.is_bound()) {
    return;
  }
  std::optional<std::string> json = base::WriteJson(payload);
  client_->Event(std::string(module), std::string(event),
                 json.value_or("null"));
}

}
