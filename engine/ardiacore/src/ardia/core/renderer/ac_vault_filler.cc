#include "ardia/core/renderer/ac_vault_filler.h"

#include <map>
#include <optional>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "ardia/core/mojom/ardiacore.mojom.h"
#include "ardia/core/renderer/ac_vault_activation.h"
#include "base/command_line.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "components/autofill/content/renderer/form_autofill_util.h"
#include "components/autofill/core/common/unique_ids.h"
#include "content/public/renderer/render_frame.h"
#include "content/public/renderer/render_frame_observer.h"
#include "mojo/public/cpp/bindings/associated_receiver_set.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_registry.h"
#include "third_party/blink/public/common/tokens/tokens.h"
#include "third_party/blink/public/mojom/forms/form_control_type.mojom-shared.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/platform/web_security_origin.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/platform/web_url.h"
#include "third_party/blink/public/web/web_autofill_state.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_form_control_element.h"
#include "third_party/blink/public/web/web_form_element.h"
#include "third_party/blink/public/web/web_frame.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "ui/base/page_transition_types.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_constants.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-function-callback.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-object.h"
#include "v8/include/v8-persistent-handle.h"
#include "v8/include/v8-primitive.h"

namespace ardiacore {

namespace {

using Outcome = mojom::ACVaultFillOutcome;

enum class FieldKind { kUsername, kPassword, kCode };

class VaultFiller;

std::map<content::RenderFrame*, VaultFiller*>& Fillers() {
  static base::NoDestructor<std::map<content::RenderFrame*, VaultFiller*>>
      fillers;
  return *fillers;
}

bool MarkedVault(blink::WebFrame* frame);

class VaultFiller : public content::RenderFrameObserver,
                    public mojom::ACVaultFiller {
 public:
  explicit VaultFiller(content::RenderFrame* frame)
      : content::RenderFrameObserver(frame), frame_(frame) {
    Fillers()[frame] = this;
    frame->GetAssociatedInterfaceRegistry()->AddInterface<mojom::ACVaultFiller>(
        base::BindRepeating(&VaultFiller::Bind, weak_factory_.GetWeakPtr()));
  }

  ~VaultFiller() override {
    Fillers().erase(frame_);
    Watchers().erase(watch_id_);
    observer_.Reset();
    if (watch_callback_) {
      std::move(watch_callback_).Run();
    }
  }

  void OnDestruct() override { delete this; }

  bool vault() const { return vault_; }

  void Fill(const url::Origin& expected_origin,
            mojom::ACVaultFillStepPtr step,
            FillCallback callback) override {
    const Outcome outcome =
        Run(expected_origin, *step, weak_factory_.GetWeakPtr());
    std::move(callback).Run(outcome);
  }

  void DidCommitProvisionalLoad(ui::PageTransition transition) override {
    filled_secrets_.clear();
    get_blocked_ = false;
    errors_before_ = ErrorBaseline();
    scope_.Reset();
    around_.Reset();
    scoped_ = false;
    watching_ = false;
    observer_.Reset();
    Watchers().erase(watch_id_);
    if (watch_callback_) {
      std::move(watch_callback_).Run();
    }
  }

  void WatchForChange(WatchForChangeCallback callback) override {
    ScopeChanged();
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      std::move(callback).Run();
      return;
    }
    watch_callback_ = std::move(callback);
    if (!watching_) {
      watching_ = true;
      std::vector<blink::WebString> selectors;
      for (const char* selector :
           {"input[type=password i]", "[class*=error i]", "[id*=error i]",
            "[data-test*=error i]", "[class*=alert-danger i]",
            "[class*=invalid-feedback i]", "[aria-invalid=true i]",
            "[role=alert i]", "[aria-live=assertive i]",
            "[aria-live=polite i]"}) {
        selectors.push_back(blink::WebString::FromAscii(selector));
      }
      frame->GetDocument().WatchCSSSelectors(selectors);
    }
    ObserveScope(frame);
  }

  void StopWatching() override {
    ScopeChanged();
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (watching_ && frame && !frame->GetDocument().IsNull()) {
      frame->GetDocument().WatchCSSSelectors({});
    }
    watching_ = false;
  }

  void DidMatchCSS(
      const std::vector<blink::WebString>& newly_matching_selectors,
      const std::vector<blink::WebString>& stopped_matching_selectors)
      override {
    ScopeChanged();
  }

  void MarkVaultFrame() override { vault_ = true; }

  bool BlockGet(const blink::WebFormElement& form) {
    if (!IsVaultFrame(render_frame())) {
      return false;
    }
    bool carries_secret = false;
    for (const blink::WebInputElement& field : filled_secrets_) {
      carries_secret |= field.IsConnected() && field.Form() == form &&
                        !field.Value().IsEmpty();
    }
    if (!carries_secret) {
      return false;
    }
    for (blink::WebInputElement& field : filled_secrets_) {
      if (field.IsConnected()) {
        field.SetValue(blink::WebString(), false);
      }
    }
    get_blocked_ = true;
    return true;
  }

  void ProbeDocument(ProbeDocumentCallback callback) override {
    auto state = mojom::ACVaultPageState::New();
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      std::move(callback).Run(std::move(state));
      return;
    }
    blink::WebDocument document = frame->GetDocument();
    state->complete = true;
    state->get_form_blocked = get_blocked_;
    state->password_field = AnyShown(document, "input[type=password i]");
    state->text_field = AnyShown(
        document,
        "input:not([type]), input[type=text i], input[type=email i], "
        "input[type=tel i], input[type=number i]");
    state->code_field = CodeFieldShown(document);
    state->challenge = ChallengeShown(document);
    state->error_shown =
        NewError(errors_before_, document, scope_, around_, scoped_);
    std::move(callback).Run(std::move(state));
  }

  void ScopeChanged() {
    DisconnectObserver();
    Watchers().erase(watch_id_);
    if (watch_callback_) {
      std::move(watch_callback_).Run();
    }
  }

  void ClearFilledPasswords() override {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      return;
    }
    blink::WebDocument document = frame->GetDocument();
    std::vector<blink::WebFormControlElement> controls =
        document.UnassociatedFormControls();
    for (const blink::WebFormElement& form : document.Forms()) {
      for (const blink::WebFormControlElement& control :
           form.GetFormControlElements()) {
        controls.push_back(control);
      }
    }
    for (blink::WebFormControlElement& control : controls) {
      if (control.FormControlTypeForAutofill() !=
          blink::mojom::FormControlType::kInputPassword) {
        continue;
      }
      if (!control.SuggestedValue().IsEmpty()) {
        control.SetSuggestedValue(blink::WebString());
      }
      if (control.GetAutofillState() != blink::WebAutofillState::kNotFilled) {
        control.SetValue(blink::WebString(), true);
        control.SetAutofillState(blink::WebAutofillState::kNotFilled);
      }
    }
  }

 private:
  static std::map<int64_t, base::WeakPtr<VaultFiller>>& Watchers() {
    static base::NoDestructor<std::map<int64_t, base::WeakPtr<VaultFiller>>>
        watchers;
    return *watchers;
  }

  static void ScopeMutated(const v8::FunctionCallbackInfo<v8::Value>& info) {
    if (info.Data().IsEmpty() || !info.Data()->IsNumber()) {
      return;
    }
    const int64_t id =
        static_cast<int64_t>(info.Data().As<v8::Number>()->Value());
    auto found = Watchers().find(id);
    if (found == Watchers().end()) {
      return;
    }
    base::WeakPtr<VaultFiller> filler = found->second;
    Watchers().erase(found);
    if (filler) {
      filler->ScopeChanged();
    }
  }

  void ObserveScope(blink::WebLocalFrame* frame) {
    static int64_t next_watch = 0;
    watch_id_ = ++next_watch;
    Watchers()[watch_id_] = weak_factory_.GetWeakPtr();
    v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
    v8::HandleScope handles(isolate);
    v8::Local<v8::Value> observe =
        frame->ExecuteScriptInIsolatedWorldAndReturnValue(
            ISOLATED_WORLD_ID_CHROME_INTERNAL,
            blink::WebScriptSource(blink::WebString::FromAscii(
                "(function (scope, changed) { const observer = new "
                "MutationObserver(() => { observer.disconnect(); changed(); }); "
                "const options = { subtree: true, childList: true, "
                "characterData: true, attributes: true }; "
                "observer.observe(scope, options); for (const region of "
                "document.querySelectorAll('[role=alert i], [aria-live]')) { "
                "observer.observe(region, options); } return observer; })")),
            blink::BackForwardCacheAware::kAllow);
    v8::Local<v8::Context> context = frame->GetScriptContextFromWorldId(
        isolate, ISOLATED_WORLD_ID_CHROME_INTERNAL);
    blink::WebElement observed =
        around_ && around_.IsConnected()   ? around_
        : scope_ && scope_.IsConnected() ? scope_
                                           : frame->GetDocument().DocumentElement();
    if (observe.IsEmpty() || !observe->IsFunction() || context.IsEmpty() ||
        !observed || !observed.IsConnected()) {
      return;
    }
    v8::Context::Scope context_scope(context);
    v8::TryCatch try_catch(isolate);
    v8::Local<v8::Function> changed;
    if (!v8::Function::New(
             context, &VaultFiller::ScopeMutated,
             v8::Number::New(isolate, static_cast<double>(watch_id_)))
             .ToLocal(&changed)) {
      return;
    }
    v8::Local<v8::Value> args[] = {observed.ToV8Value(isolate), changed};
    v8::Local<v8::Value> observer;
    if (frame
            ->CallFunctionEvenIfScriptDisabled(observe.As<v8::Function>(),
                                               v8::Undefined(isolate), 2, args)
            .ToLocal(&observer) &&
        !try_catch.HasCaught() && observer->IsObject()) {
      observer_isolate_ = isolate;
      observer_.Reset(isolate, observer);
    }
  }

  void DisconnectObserver() {
    if (observer_.IsEmpty()) {
      return;
    }
    blink::WebLocalFrame* frame =
        render_frame() ? render_frame()->GetWebFrame() : nullptr;
    v8::Isolate* isolate = observer_isolate_;
    if (frame && isolate) {
      v8::HandleScope handles(isolate);
      v8::Local<v8::Context> context = frame->GetScriptContextFromWorldId(
          isolate, ISOLATED_WORLD_ID_CHROME_INTERNAL);
      if (!context.IsEmpty()) {
        v8::Context::Scope context_scope(context);
        v8::TryCatch try_catch(isolate);
        v8::Local<v8::Value> observer = observer_.Get(isolate);
        v8::Local<v8::Value> disconnect;
        if (observer->IsObject() &&
            observer.As<v8::Object>()
                ->Get(context,
                      v8::String::NewFromUtf8Literal(isolate, "disconnect"))
                .ToLocal(&disconnect) &&
            disconnect->IsFunction()) {
          std::ignore = frame->CallFunctionEvenIfScriptDisabled(
              disconnect.As<v8::Function>(), observer, 0, nullptr);
        }
      }
    }
    observer_.Reset();
  }

  static bool Intact(const base::WeakPtr<VaultFiller>& self,
                     const blink::DocumentToken& document) {
    if (!self || !self->render_frame()) {
      return false;
    }
    blink::WebLocalFrame* frame = self->render_frame()->GetWebFrame();
    return frame && !frame->GetDocument().IsNull() &&
           frame->GetDocument().Token() == document;
  }

  void Bind(mojo::PendingAssociatedReceiver<mojom::ACVaultFiller> receiver) {
    receivers_.Add(this, std::move(receiver));
  }

  Outcome Run(const url::Origin& expected_origin,
              const mojom::ACVaultFillStep& step,
              base::WeakPtr<VaultFiller> self) {
    blink::WebLocalFrame* frame = render_frame()->GetWebFrame();
    if (!frame || frame->GetDocument().IsNull()) {
      return Outcome::kOriginChanged;
    }
    const blink::DocumentToken document = frame->GetDocument().Token();
    const url::Origin origin(frame->GetDocument().GetSecurityOrigin());
    const GURL document_url(frame->GetDocument().Url());
    if (origin.opaque() || !origin.IsSameOriginWith(expected_origin) ||
        !document_url.SchemeIsHTTPOrHTTPS() ||
        !url::Origin::Create(document_url).IsSameOriginWith(expected_origin)) {
      return Outcome::kOriginChanged;
    }
    blink::WebInputElement username;
    blink::WebInputElement password;
    blink::WebInputElement code;
    for (auto [id, kind, slot] :
         {std::tuple(step.username_field, FieldKind::kUsername, &username),
          std::tuple(step.password_field, FieldKind::kPassword, &password),
          std::tuple(step.code_field, FieldKind::kCode, &code)}) {
      if (!id) {
        continue;
      }
      std::optional<Outcome> refused = Resolve(frame, step.form, id, kind, slot);
      if (refused) {
        return *refused;
      }
    }
    std::vector<blink::WebInputElement> fields;
    for (const blink::WebInputElement* field : {&username, &password, &code}) {
      if (*field) {
        fields.push_back(*field);
      }
    }
    if (fields.empty()) {
      return Outcome::kFieldMissing;
    }
    const blink::WebFormElement owner =
        password ? password.Form() : blink::WebFormElement();
    const blink::WebFormElement code_owner =
        code ? code.Form() : blink::WebFormElement();
    get_blocked_ = false;
    for (const blink::WebInputElement& field : fields) {
      blink::WebFormElement form = field.Form();
      if (form && !FormDestinationAllowed(frame, expected_origin, form)) {
        return Outcome::kDestinationRefused;
      }
    }
    SignInControl chosen;
    if (step.submit) {
      chosen = ChooseActivation(frame, expected_origin, fields, true);
      if (!Intact(self, document)) {
        return Outcome::kInterruptedBeforeActivation;
      }
      if (chosen.result == ControlSearch::kRefused) {
        return Outcome::kSubmitterRefused;
      }
      if (chosen.result != ControlSearch::kClick &&
          chosen.result != ControlSearch::kRequestSubmit) {
        return Outcome::kNoSubmitControl;
      }
      scope_ = chosen.scope ? chosen.scope : ElementAbove(fields.back());
      around_ = scope_ ? ElementAbove(scope_) : blink::WebElement();
      scoped_ = true;
      errors_before_ = Errors(frame->GetDocument(), scope_, around_);
    }
    for (auto [field, value] :
         {std::pair(&username, &step.username),
          std::pair(&password, &step.password), std::pair(&code, &step.code)}) {
      if (!*field) {
        continue;
      }
      if (field == &password && !IsLogin(password, owner, scope_, around_)) {
        return Outcome::kNotLogin;
      }
      if (field == &code && !CodeStillVerifies(code, code_owner, scope_, around_)) {
        return Outcome::kNotLogin;
      }
      if (field == &username) {
        field->SetAutofillValue(blink::WebString::FromUtf16(*value));
      } else {
        filled_secrets_.push_back(*field);
        field->SetValue(blink::WebString::FromUtf16(*value), true);
      }
      if (!self) {
        return Outcome::kInterruptedBeforeActivation;
      }
      if (get_blocked_) {
        return Outcome::kGetForm;
      }
      if (!Intact(self, document)) {
        return Outcome::kInterruptedBeforeActivation;
      }
      if (field == &password && !IsLogin(password, owner, scope_, around_)) {
        password.SetValue(blink::WebString(), false);
        return Outcome::kNotLogin;
      }
      if (field == &code && !CodeStillVerifies(code, code_owner, scope_, around_)) {
        code.SetValue(blink::WebString(), false);
        return Outcome::kNotLogin;
      }
      if (!field->IsConnected() || field->Value().Utf16() != *value) {
        return Outcome::kFieldChanged;
      }
    }
    if (!step.submit) {
      return Outcome::kFilled;
    }
    if (password && !IsLogin(password, owner, scope_, around_)) {
      return Outcome::kNotLogin;
    }
    const SignInControl again =
        ChooseActivation(frame, expected_origin, fields, false);
    if (!Intact(self, document)) {
      return Outcome::kInterruptedBeforeActivation;
    }
    if (!SameActivation(chosen, again)) {
      return Outcome::kNoSubmitControl;
    }
    const bool ran = RunActivation(frame, again);
    if (!self) {
      return Outcome::kInterrupted;
    }
    if (get_blocked_) {
      return Outcome::kGetForm;
    }
    if (!Intact(self, document)) {
      return Outcome::kInterrupted;
    }
    return ran ? Outcome::kSubmitted : Outcome::kInterruptedBeforeActivation;
  }

  std::optional<Outcome> Resolve(blink::WebLocalFrame* frame,
                                 uint64_t form,
                                 uint64_t id,
                                 FieldKind kind,
                                 blink::WebInputElement* slot) {
    blink::WebFormControlElement control =
        autofill::form_util::GetFormControlByRendererId(
            autofill::FieldRendererId(id));
    blink::WebInputElement input =
        control ? control.DynamicTo<blink::WebInputElement>()
                : blink::WebInputElement();
    if (!input || input.GetDocument().GetFrame() != frame) {
      return Outcome::kFieldMissing;
    }
    if (!input.IsEnabled() || input.IsReadOnly() || !input.IsConnected()) {
      return Outcome::kFieldChanged;
    }
    if (autofill::form_util::GetFormRendererId(
            input.GetOwningFormForAutofill()) != autofill::FormRendererId(form)) {
      return Outcome::kFieldChanged;
    }
    const bool is_password = input.FormControlTypeForAutofill() ==
                             blink::mojom::FormControlType::kInputPassword;
    if ((kind == FieldKind::kPassword && !is_password) ||
        (kind == FieldKind::kUsername && (is_password || !input.IsTextField())) ||
        (kind == FieldKind::kCode && !input.IsTextField() && !is_password)) {
      return Outcome::kFieldChanged;
    }
    *slot = input;
    return std::nullopt;
  }

  raw_ptr<content::RenderFrame> frame_;
  bool vault_ = false;
  bool scoped_ = false;
  ErrorBaseline errors_before_;
  std::vector<blink::WebInputElement> filled_secrets_;
  bool get_blocked_ = false;
  blink::WebElement scope_;
  blink::WebElement around_;
  bool watching_ = false;
  int64_t watch_id_ = 0;
  WatchForChangeCallback watch_callback_;
  raw_ptr<v8::Isolate> observer_isolate_ = nullptr;
  v8::Global<v8::Value> observer_;
  mojo::AssociatedReceiverSet<mojom::ACVaultFiller> receivers_;
  base::WeakPtrFactory<VaultFiller> weak_factory_{this};
};

bool MarkedVault(blink::WebFrame* frame) {
  if (!frame || !frame->IsWebLocalFrame()) {
    return false;
  }
  content::RenderFrame* render_frame =
      content::RenderFrame::FromWebFrame(frame->ToWebLocalFrame());
  auto filler = render_frame ? Fillers().find(render_frame) : Fillers().end();
  return filler != Fillers().end() && filler->second->vault();
}

}

bool BlockVaultGetSubmission(const blink::WebFormElement& form) {
  blink::WebLocalFrame* frame =
      form.IsNull() ? nullptr : form.GetDocument().GetFrame();
  content::RenderFrame* render_frame =
      frame ? content::RenderFrame::FromWebFrame(frame) : nullptr;
  auto filler = render_frame ? Fillers().find(render_frame) : Fillers().end();
  return filler != Fillers().end() && filler->second->BlockGet(form);
}

void AttachVaultFiller(content::RenderFrame* frame) {
  new VaultFiller(frame);
}

bool IsVaultFrame(content::RenderFrame* render_frame) {
  static const bool vault_process =
      base::CommandLine::ForCurrentProcess()->HasSwitch(kVaultRendererSwitch);
  if (vault_process) {
    return true;
  }
  blink::WebLocalFrame* frame =
      render_frame ? render_frame->GetWebFrame() : nullptr;
  for (blink::WebFrame* step = frame; step; step = step->Parent()) {
    if (MarkedVault(step) || MarkedVault(step->Opener())) {
      return true;
    }
  }
  return false;
}

}
