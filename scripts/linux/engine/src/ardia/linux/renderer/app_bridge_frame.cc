#include "ardia/linux/renderer/app_bridge_frame.h"

#include <tuple>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "content/public/common/bindings_policy.h"
#include "content/public/common/isolated_world_ids.h"
#include "content/public/common/url_constants.h"
#include "content/public/renderer/render_frame.h"
#include "gin/arguments.h"
#include "gin/converter.h"
#include "gin/function_template.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "url/gurl.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-json.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-microtask-queue.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-primitive.h"
#include "v8/include/v8-promise.h"

namespace ardia_linux {

namespace {

constexpr char kBridgeName[] = "ardiaLinux";
constexpr char kAppHost[] = "ardia-app";
constexpr char kNoBridge[] =
    "{\"error\":\"This sender can't use Ardia's native bridge\","
    "\"code\":\"ERR_LINUX_BRIDGE_SENDER\"}";

v8::Local<v8::String> V8String(v8::Isolate* isolate, std::string_view text) {
  return gin::StringToV8(isolate, text);
}

v8::Local<v8::Value> ParseJson(v8::Local<v8::Context> context,
                               const std::string& json) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::Local<v8::Value> parsed;
  if (!v8::JSON::Parse(context, V8String(isolate, json)).ToLocal(&parsed)) {
    return v8::Undefined(isolate);
  }
  return parsed;
}

bool ArgsJson(v8::Local<v8::Context> context,
              v8::Local<v8::Value> value,
              std::string* json) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  if (value.IsEmpty() || value->IsUndefined() || value->IsNull()) {
    *json = "[]";
    return true;
  }
  if (!value->IsArray()) {
    return false;
  }
  v8::Local<v8::String> text;
  if (!v8::JSON::Stringify(context, value).ToLocal(&text)) {
    return false;
  }
  *json = gin::V8ToString(isolate, text);
  return true;
}

v8::Local<v8::Value> ErrorFromReply(v8::Local<v8::Context> context,
                                    v8::Local<v8::Value> reply,
                                    const std::string& module,
                                    const std::string& method) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  if (!reply->IsObject()) {
    return v8::Local<v8::Value>();
  }
  v8::Local<v8::Object> object = reply.As<v8::Object>();
  v8::Local<v8::Value> message;
  if (!object->Get(context, V8String(isolate, "error")).ToLocal(&message) ||
      !message->IsString()) {
    return v8::Local<v8::Value>();
  }
  v8::Local<v8::Value> code;
  if (!object->Get(context, V8String(isolate, "code")).ToLocal(&code) ||
      !code->IsString()) {
    code = V8String(isolate, "ERR_LINUX_NATIVE");
  }
  v8::Local<v8::Object> error =
      v8::Exception::Error(message.As<v8::String>()).As<v8::Object>();
  std::ignore = error->Set(context, V8String(isolate, "code"), code);
  std::ignore =
      error->Set(context, V8String(isolate, "module"), V8String(isolate, module));
  std::ignore =
      error->Set(context, V8String(isolate, "method"), V8String(isolate, method));
  return error;
}

v8::Local<v8::Value> ValueFromReply(v8::Local<v8::Context> context,
                                    v8::Local<v8::Value> reply) {
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::Local<v8::Value> value;
  if (!reply->IsObject() || !reply.As<v8::Object>()
                                  ->Get(context, V8String(isolate, "value"))
                                  .ToLocal(&value)) {
    return v8::Undefined(isolate);
  }
  return value;
}

bool ReadName(gin::Arguments* args, std::string* name) {
  v8::Local<v8::Value> value;
  if (!args->GetNext(&value) || !value->IsString()) {
    return false;
  }
  *name = gin::V8ToString(args->isolate(), value);
  return true;
}

}

AppBridgeFrame::AppBridgeFrame(content::RenderFrame* frame)
    : content::RenderFrameObserver(frame) {}

AppBridgeFrame::~AppBridgeFrame() = default;

void AppBridgeFrame::OnDestruct() {
  delete this;
}

bool AppBridgeFrame::IsAppDocument() const {
  if (!render_frame()->IsMainFrame() ||
      !render_frame()->GetEnabledBindings().Has(
          content::BindingsPolicyValue::kWebUi)) {
    return false;
  }
  const GURL url = render_frame()->GetWebFrame()->GetDocument().Url();
  return url.SchemeIs(content::kChromeUIScheme) && url.host() == kAppHost;
}

void AppBridgeFrame::DidCreateScriptContext(v8::Local<v8::Context> context,
                                            int32_t world_id) {
  if (world_id != content::ISOLATED_WORLD_ID_GLOBAL || !IsAppDocument()) {
    return;
  }
  Install(context);
}

void AppBridgeFrame::WillReleaseScriptContext(v8::Local<v8::Context> context,
                                              int32_t world_id) {
  if (world_id != content::ISOLATED_WORLD_ID_GLOBAL || context_.IsEmpty()) {
    return;
  }
  Forget();
}

void AppBridgeFrame::Forget() {
  listeners_.clear();
  pending_.clear();
  context_.Reset();
  client_.reset();
  bridge_.reset();
  weak_factory_.InvalidateWeakPtrs();
}

void AppBridgeFrame::Install(v8::Local<v8::Context> context) {
  Forget();
  v8::Isolate* isolate = v8::Isolate::GetCurrent();
  v8::HandleScope handles(isolate);
  render_frame()->GetRemoteAssociatedInterfaces()->GetInterface(&bridge_);
  bridge_->SetClient(client_.BindNewEndpointAndPassRemote());
  context_.Reset(isolate, context);

  v8::Context::Scope scope(context);
  v8::Local<v8::Object> object = v8::Object::New(isolate);
  auto define = [&](const char* name, v8::Local<v8::FunctionTemplate> made) {
    std::ignore = object->CreateDataProperty(
        context, V8String(isolate, name),
        made->GetFunction(context).ToLocalChecked());
  };
  base::WeakPtr<AppBridgeFrame> self = weak_factory_.GetWeakPtr();
  define("modules", gin::CreateFunctionTemplate(
                        isolate, base::BindRepeating(&AppBridgeFrame::Modules,
                                                     self)));
  define("callSync",
         gin::CreateFunctionTemplate(
             isolate, base::BindRepeating(&AppBridgeFrame::CallSync, self,
                                          true)));
  define("callSyncRaw",
         gin::CreateFunctionTemplate(
             isolate, base::BindRepeating(&AppBridgeFrame::CallSync, self,
                                          false)));
  define("call", gin::CreateFunctionTemplate(
                     isolate,
                     base::BindRepeating(&AppBridgeFrame::Call, self, true)));
  define("callRaw", gin::CreateFunctionTemplate(
                        isolate, base::BindRepeating(&AppBridgeFrame::Call,
                                                     self, false)));
  define("onEvent", gin::CreateFunctionTemplate(
                        isolate, base::BindRepeating(&AppBridgeFrame::OnEvent,
                                                     self)));
  std::ignore = object->SetIntegrityLevel(context, v8::IntegrityLevel::kFrozen);
  std::ignore = context->Global()->DefineOwnProperty(
      context, V8String(isolate, kBridgeName), object,
      static_cast<v8::PropertyAttribute>(v8::ReadOnly | v8::DontDelete |
                                         v8::DontEnum));
}

void AppBridgeFrame::Modules(gin::Arguments* args) {
  v8::Isolate* isolate = args->isolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  std::string json = "{}";
  if (!bridge_ || !bridge_->Modules(&json)) {
    json = "{}";
  }
  args->Return(ParseJson(context, json));
}

void AppBridgeFrame::CallSync(bool unwrap, gin::Arguments* args) {
  v8::Isolate* isolate = args->isolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  std::string module;
  std::string method;
  v8::Local<v8::Value> values;
  std::string json;
  if (!ReadName(args, &module) || !ReadName(args, &method)) {
    args->ThrowTypeError("callSync(module, method, args)");
    return;
  }
  args->GetNext(&values);
  if (!ArgsJson(context, values, &json)) {
    args->ThrowTypeError("the arguments must be a JSON-able array");
    return;
  }
  std::string reply = kNoBridge;
  if (!bridge_ || !bridge_->CallSync(module, method, json, &reply)) {
    reply = kNoBridge;
  }
  v8::Local<v8::Value> parsed = ParseJson(context, reply);
  if (!unwrap) {
    args->Return(parsed);
    return;
  }
  v8::Local<v8::Value> error = ErrorFromReply(context, parsed, module, method);
  if (!error.IsEmpty()) {
    isolate->ThrowException(error);
    return;
  }
  args->Return(ValueFromReply(context, parsed));
}

void AppBridgeFrame::Call(bool unwrap, gin::Arguments* args) {
  v8::Isolate* isolate = args->isolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  std::string module;
  std::string method;
  v8::Local<v8::Value> values;
  std::string json;
  v8::Local<v8::Promise::Resolver> resolver;
  if (!v8::Promise::Resolver::New(context).ToLocal(&resolver)) {
    return;
  }
  args->Return(resolver->GetPromise());
  if (!ReadName(args, &module) || !ReadName(args, &method)) {
    std::ignore = resolver->Reject(
        context, v8::Exception::TypeError(
                     V8String(isolate, "call(module, method, args)")));
    return;
  }
  args->GetNext(&values);
  if (!ArgsJson(context, values, &json)) {
    std::ignore = resolver->Reject(
        context,
        v8::Exception::TypeError(
            V8String(isolate, "the arguments must be a JSON-able array")));
    return;
  }
  const int id = ++last_id_;
  pending_[id] = Pending{v8::Global<v8::Promise::Resolver>(isolate, resolver),
                         unwrap, module, method};
  if (!bridge_) {
    Answered(id, kNoBridge);
    return;
  }
  bridge_->Call(module, method, json,
                base::BindOnce(&AppBridgeFrame::Answered,
                               weak_factory_.GetWeakPtr(), id));
}

void AppBridgeFrame::Answered(int id, const std::string& reply) {
  auto found = pending_.find(id);
  if (found == pending_.end() || context_.IsEmpty()) {
    return;
  }
  Pending pending = std::move(found->second);
  pending_.erase(found);
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handles(isolate);
  v8::Local<v8::Context> context = context_.Get(isolate);
  v8::Context::Scope scope(context);
  v8::MicrotasksScope microtasks(context,
                                 v8::MicrotasksScope::kRunMicrotasks);
  v8::Local<v8::Promise::Resolver> resolver = pending.resolver.Get(isolate);
  v8::Local<v8::Value> parsed = ParseJson(context, reply);
  if (!pending.unwrap) {
    std::ignore = resolver->Resolve(context, parsed);
    return;
  }
  v8::Local<v8::Value> error =
      ErrorFromReply(context, parsed, pending.module, pending.method);
  if (!error.IsEmpty()) {
    std::ignore = resolver->Reject(context, error);
    return;
  }
  std::ignore = resolver->Resolve(context, ValueFromReply(context, parsed));
}

void AppBridgeFrame::OnEvent(gin::Arguments* args) {
  v8::Isolate* isolate = args->isolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  v8::Local<v8::Value> listener;
  if (!args->GetNext(&listener) || !listener->IsFunction()) {
    args->ThrowTypeError("onEvent(listener)");
    return;
  }
  const int id = ++last_id_;
  listeners_[id] =
      v8::Global<v8::Function>(isolate, listener.As<v8::Function>());
  args->Return(gin::CreateFunctionTemplate(
                   isolate, base::BindRepeating(&AppBridgeFrame::RemoveListener,
                                                weak_factory_.GetWeakPtr(), id))
                   ->GetFunction(context)
                   .ToLocalChecked());
}

void AppBridgeFrame::RemoveListener(int id, gin::Arguments* args) {
  listeners_.erase(id);
}

void AppBridgeFrame::Event(const std::string& module,
                           const std::string& event,
                           const std::string& json) {
  if (context_.IsEmpty() || listeners_.empty()) {
    return;
  }
  blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handles(isolate);
  v8::Local<v8::Context> context = context_.Get(isolate);
  v8::Context::Scope scope(context);
  std::vector<v8::Local<v8::Function>> listeners;
  for (const auto& [id, listener] : listeners_) {
    listeners.push_back(listener.Get(isolate));
  }
  v8::Local<v8::Value> values[] = {V8String(isolate, module),
                                   V8String(isolate, event),
                                   ParseJson(context, json)};
  base::WeakPtr<AppBridgeFrame> alive = weak_factory_.GetWeakPtr();
  for (v8::Local<v8::Function> listener : listeners) {
    std::ignore = frame->CallFunctionEvenIfScriptDisabled(
        listener, v8::Undefined(isolate), std::size(values), values);
    if (!alive) {
      return;
    }
  }
}

}
