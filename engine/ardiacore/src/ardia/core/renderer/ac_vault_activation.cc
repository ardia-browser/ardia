#include "ardia/core/renderer/ac_vault_activation.h"

#include <algorithm>
#include <initializer_list>
#include <string>
#include <string_view>
#include <tuple>
#include <vector>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "third_party/blink/public/mojom/forms/form_control_type.mojom-shared.h"
#include "third_party/blink/public/platform/scheduler/web_agent_group_scheduler.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_local_frame.h"
#include "third_party/blink/public/web/web_script_source.h"
#include "ui/gfx/geometry/rect.h"
#include "url/gurl.h"
#include "url/url_constants.h"
#include "v8/include/v8-context.h"
#include "v8/include/v8-exception.h"
#include "v8/include/v8-function.h"
#include "v8/include/v8-isolate.h"
#include "v8/include/v8-local-handle.h"
#include "v8/include/v8-primitive.h"

namespace ardiacore {

namespace {

constexpr int kMostLevelsUp = 3;

blink::WebString Ascii(std::string_view text) {
  return blink::WebString::FromAscii(std::string(text));
}

std::string Lower(const blink::WebString& value) {
  return base::ToLowerASCII(
      base::TrimWhitespaceASCII(value.Utf8(), base::TRIM_ALL));
}

blink::WebElement ParentElement(const blink::WebNode& node) {
  blink::WebNode parent = node.ParentNode();
  return !parent.IsNull() && parent.IsElementNode()
             ? parent.To<blink::WebElement>()
             : blink::WebElement();
}

bool Inside(const blink::WebNode& node, const blink::WebNode& ancestor) {
  for (blink::WebNode step = node.ParentNode(); !step.IsNull();
       step = step.ParentNode()) {
    if (step == ancestor) {
      return true;
    }
  }
  return false;
}

bool IsPageRoot(const blink::WebElement& element) {
  return element.HasHTMLTagName(Ascii("body")) ||
         element.HasHTMLTagName(Ascii("html"));
}

bool Disabled(const blink::WebElement& element) {
  if (Lower(element.GetAttribute(Ascii("aria-disabled"))) == "true") {
    return true;
  }
  blink::WebFormControlElement control =
      element.DynamicTo<blink::WebFormControlElement>();
  return control ? !control.IsEnabled()
                 : element.HasAttribute(Ascii("disabled"));
}

blink::WebString BaseTarget(blink::WebLocalFrame* frame) {
  blink::WebElement base =
      frame->GetDocument().QuerySelector(Ascii("base[target]"));
  return base ? base.GetAttribute(Ascii("target")) : blink::WebString();
}

blink::WebString EffectiveTarget(blink::WebLocalFrame* frame,
                                 const blink::WebElement& element) {
  const blink::WebString target = element.GetAttribute(Ascii("target"));
  return target.IsEmpty() ? BaseTarget(frame) : target;
}

bool TargetsSelf(blink::WebLocalFrame* frame, const blink::WebString& target) {
  const std::string name = target.Utf8();
  return name.empty() || base::EqualsCaseInsensitiveASCII(name, "_self");
}

std::string EffectiveMethod(const blink::WebFormElement& form,
                            const blink::WebFormControlElement& submitter) {
  const blink::WebString form_method = Ascii("formmethod");
  const std::string method =
      (submitter && submitter.HasAttribute(form_method)
           ? submitter.GetAttribute(form_method)
           : form.GetAttribute(Ascii("method")))
          .Utf8();
  if (base::EqualsCaseInsensitiveASCII(method, "post")) {
    return "post";
  }
  return base::EqualsCaseInsensitiveASCII(method, "dialog") ? "dialog" : "get";
}

bool LinkAllowed(blink::WebLocalFrame* frame,
                 const url::Origin& expected_origin,
                 const blink::WebElement& link) {
  return !link.HasAttribute(Ascii("download")) &&
         TargetsSelf(frame, EffectiveTarget(frame, link)) &&
         SameOriginURL(frame, link.GetAttribute(Ascii("href")),
                       expected_origin);
}

bool SubmitterAllowedFor(blink::WebLocalFrame* frame,
                         const url::Origin& expected_origin,
                         const blink::WebFormElement& form,
                         const blink::WebFormControlElement& submitter) {
  blink::WebString target =
      submitter && submitter.HasAttribute(Ascii("formtarget"))
          ? submitter.GetAttribute(Ascii("formtarget"))
          : form.GetAttribute(Ascii("target"));
  if (target.IsEmpty()) {
    target = BaseTarget(frame);
  }
  if (!TargetsSelf(frame, target)) {
    return false;
  }
  const blink::WebString form_action = Ascii("formaction");
  return !submitter || !submitter.HasAttribute(form_action) ||
         SameOriginURL(frame, submitter.GetAttribute(form_action),
                       expected_origin);
}

enum class ControlKind { kNone, kSubmit, kPlain, kLink };

ControlKind KindOf(const blink::WebElement& element) {
  if (element.HasHTMLTagName(Ascii("a"))) {
    return element.HasAttribute(Ascii("href")) ? ControlKind::kLink
                                               : ControlKind::kNone;
  }
  blink::WebFormControlElement control =
      element.DynamicTo<blink::WebFormControlElement>();
  if (control) {
    switch (control.FormControlType()) {
      case blink::mojom::FormControlType::kButtonSubmit:
      case blink::mojom::FormControlType::kInputSubmit:
      case blink::mojom::FormControlType::kInputImage:
        return ControlKind::kSubmit;
      case blink::mojom::FormControlType::kButtonButton:
      case blink::mojom::FormControlType::kInputButton:
        return ControlKind::kPlain;
      default:
        return ControlKind::kNone;
    }
  }
  return Lower(element.GetAttribute(Ascii("role"))) == "button"
             ? ControlKind::kPlain
             : ControlKind::kNone;
}

bool IsNativeButton(const blink::WebElement& element) {
  return element.HasHTMLTagName(Ascii("button")) ||
         element.HasHTMLTagName(Ascii("input"));
}

template <typename Read>
bool CallInIsolatedWorld(blink::WebLocalFrame* frame,
                         std::string_view source,
                         blink::WebNode node,
                         Read read) {
  v8::Isolate* isolate = frame->GetAgentGroupScheduler()->Isolate();
  v8::HandleScope handles(isolate);
  v8::Local<v8::Value> function =
      frame->ExecuteScriptInIsolatedWorldAndReturnValue(
          ISOLATED_WORLD_ID_CHROME_INTERNAL,
          blink::WebScriptSource(Ascii(source)),
          blink::BackForwardCacheAware::kAllow);
  if (function.IsEmpty() || !function->IsFunction() || !node.IsConnected()) {
    return false;
  }
  v8::Local<v8::Context> context = frame->GetScriptContextFromWorldId(
      isolate, ISOLATED_WORLD_ID_CHROME_INTERNAL);
  if (context.IsEmpty()) {
    return false;
  }
  v8::Context::Scope context_scope(context);
  v8::TryCatch try_catch(isolate);
  v8::Local<v8::Value> args[] = {node.ToV8Value(isolate)};
  v8::Local<v8::Value> result;
  if (!frame
           ->CallFunctionEvenIfScriptDisabled(function.As<v8::Function>(),
                                              v8::Undefined(isolate), 1, args)
           .ToLocal(&result) ||
      try_catch.HasCaught()) {
    return false;
  }
  read(isolate, result);
  return true;
}

std::u16string VisibleText(blink::WebLocalFrame* frame,
                           const blink::WebElement& element) {
  std::u16string text;
  CallInIsolatedWorld(
      frame, "(function (element) { return element.innerText || ''; })",
      element, [&](v8::Isolate* isolate, v8::Local<v8::Value> value) {
        if (value->IsString()) {
          v8::String::Utf8Value characters(isolate, value);
          if (*characters) {
            text = base::UTF8ToUTF16(
                std::string_view(*characters, characters.length()));
          }
        }
      });
  return text;
}

std::string AccessibleName(blink::WebLocalFrame* frame,
                           const blink::WebElement& element,
                           const blink::WebElement& scope) {
  const std::string labelled_by =
      element.GetAttribute(Ascii("aria-labelledby")).Utf8();
  if (!labelled_by.empty()) {
    std::u16string text;
    for (std::string_view id : base::SplitStringPiece(
             labelled_by, " \t\n", base::TRIM_WHITESPACE,
             base::SPLIT_WANT_NONEMPTY)) {
      blink::WebElement label =
          element.GetDocument().GetElementById(blink::WebString::FromUtf8(id));
      if (label && scope && (label == scope || Inside(label, scope)) &&
          IsShown(label)) {
        text += VisibleText(frame, label) + u" ";
      }
    }
    const std::string name = NormalizedName(text);
    if (!name.empty()) {
      return name;
    }
  }
  const std::string label =
      NormalizedName(element.GetAttribute(Ascii("aria-label")).Utf16());
  if (!label.empty()) {
    return label;
  }
  if (element.HasHTMLTagName(Ascii("input"))) {
    blink::WebFormControlElement control =
        element.DynamicTo<blink::WebFormControlElement>();
    const blink::mojom::FormControlType type =
        control ? control.FormControlType()
                : blink::mojom::FormControlType::kInputText;
    if (type == blink::mojom::FormControlType::kInputImage) {
      return NormalizedName(element.GetAttribute(Ascii("alt")).Utf16());
    }
    const std::string value =
        NormalizedName(element.GetAttribute(Ascii("value")).Utf16());
    if (!value.empty() || type != blink::mojom::FormControlType::kInputSubmit) {
      return value;
    }
    return "submit";
  }
  const std::string text = NormalizedName(VisibleText(frame, element));
  return text.empty()
             ? NormalizedName(element.GetAttribute(Ascii("title")).Utf16())
             : text;
}

bool ControlAllowed(blink::WebLocalFrame* frame,
                    const url::Origin& expected_origin,
                    const blink::WebElement& element,
                    ControlKind kind) {
  if (!(element.GetDocument() == frame->GetDocument()) ||
      element.HasHTMLTagName(Ascii("label"))) {
    return false;
  }
  for (blink::WebNode step = element.ParentOrShadowHostNode(); !step.IsNull();
       step = step.ParentOrShadowHostNode()) {
    if (!step.IsElementNode()) {
      continue;
    }
    const blink::WebElement ancestor = step.To<blink::WebElement>();
    if (ancestor.HasHTMLTagName(Ascii("a")) &&
        ancestor.HasAttribute(Ascii("href")) &&
        !LinkAllowed(frame, expected_origin, ancestor)) {
      return false;
    }
    if (ancestor.HasHTMLTagName(Ascii("label")) && !IsNativeButton(element)) {
      return false;
    }
  }
  if (kind == ControlKind::kLink) {
    return LinkAllowed(frame, expected_origin, element);
  }
  blink::WebFormControlElement control =
      element.DynamicTo<blink::WebFormControlElement>();
  if (!control || kind != ControlKind::kSubmit) {
    return true;
  }
  blink::WebFormElement owner = control.Form();
  return !owner ||
         (FormDestinationAllowed(frame, expected_origin, owner) &&
          SubmitterAllowedFor(frame, expected_origin, owner, control));
}

std::string Destination(blink::WebLocalFrame* frame,
                        const blink::WebElement& element,
                        ControlKind kind) {
  auto resolved = [&](const blink::WebString& value) {
    return GURL(value.IsEmpty() ? frame->GetDocument().Url()
                                : frame->GetDocument().CompleteURL(value))
        .spec();
  };
  if (kind == ControlKind::kLink) {
    return resolved(element.GetAttribute(Ascii("href"))) + " " +
           EffectiveTarget(frame, element).Utf8();
  }
  blink::WebFormControlElement control =
      element.DynamicTo<blink::WebFormControlElement>();
  blink::WebFormElement owner = control ? control.Form() : blink::WebFormElement();
  if (kind != ControlKind::kSubmit || !owner) {
    return std::string();
  }
  const blink::WebString form_action = Ascii("formaction");
  return resolved(control.HasAttribute(form_action)
                      ? control.GetAttribute(form_action)
                      : owner.Action());
}

std::string SubmissionOf(const blink::WebElement& element, ControlKind kind) {
  blink::WebFormControlElement control =
      element.DynamicTo<blink::WebFormControlElement>();
  blink::WebFormElement owner = control ? control.Form() : blink::WebFormElement();
  if (kind != ControlKind::kSubmit || !owner) {
    return std::string();
  }
  const blink::WebString form_target = Ascii("formtarget");
  return EffectiveMethod(owner, control) + " " +
         (control.HasAttribute(form_target)
              ? control.GetAttribute(form_target)
              : owner.GetAttribute(Ascii("target")))
             .Utf8();
}

std::string Intent(blink::WebLocalFrame* frame,
                   const blink::WebElement& element,
                   ControlKind kind,
                   const std::string& name) {
  return base::NumberToString(static_cast<int>(kind)) + "\n" + name + "\n" +
         Destination(frame, element, kind) + "\n" +
         SubmissionOf(element, kind);
}

bool UsableImage(const blink::WebElement& element) {
  blink::WebFormControlElement control =
      element.DynamicTo<blink::WebFormControlElement>();
  return !control ||
         control.FormControlType() != blink::mojom::FormControlType::kInputImage ||
         !NormalizedName(element.GetAttribute(Ascii("alt")).Utf16()).empty();
}

std::vector<blink::WebElement> ControlsIn(const blink::WebNode& root) {
  return root.QuerySelectorAll(
      Ascii("button, input[type=submit i], input[type=button i], "
            "input[type=image i], a[href], [role=button i]"));
}

SignInControl Labelled(blink::WebLocalFrame* frame,
                       const url::Origin& expected_origin,
                       const std::vector<blink::WebElement>& candidates,
                       const std::vector<blink::WebInputElement>& fields,
                       const blink::WebFormElement& form,
                       const blink::WebElement& scope,
                       bool preflight) {
  std::vector<std::tuple<blink::WebElement, ControlKind, std::string>> matched;
  for (const blink::WebElement& element : candidates) {
    if (std::ranges::any_of(fields,
                            [&](const blink::WebInputElement& field) {
                              return field == element;
                            }) ||
        std::ranges::any_of(matched, [&](const auto& seen) {
          return std::get<0>(seen) == element;
        })) {
      continue;
    }
    const ControlKind kind = KindOf(element);
    if (kind == ControlKind::kNone || (!preflight && Disabled(element)) ||
        !IsShown(element) || !UsableImage(element)) {
      continue;
    }
    blink::WebFormControlElement control =
        element.DynamicTo<blink::WebFormControlElement>();
    if (control && !(control.Form() == form)) {
      continue;
    }
    std::string name = AccessibleName(frame, element, scope);
    if (!NameReadsAsSignIn(name)) {
      continue;
    }
    matched.emplace_back(element, kind, std::move(name));
  }
  SignInControl chosen;
  chosen.form = form;
  chosen.scope = scope;
  if (matched.empty()) {
    chosen.result = ControlSearch::kNone;
  } else if (matched.size() > 1) {
    chosen.result = ControlSearch::kAmbiguous;
  } else {
    const auto& [element, kind, name] = matched.front();
    if (!ControlAllowed(frame, expected_origin, element, kind)) {
      chosen.result = ControlSearch::kRefused;
    } else {
      chosen.result = ControlSearch::kClick;
      chosen.control = element;
      chosen.intent = Intent(frame, element, kind, name);
      blink::WebFormControlElement control =
          element.DynamicTo<blink::WebFormControlElement>();
      if (kind == ControlKind::kSubmit && control && control.Form()) {
        chosen.method = EffectiveMethod(control.Form(), control);
      }
    }
  }
  return chosen;
}

blink::WebElement CommonContainer(
    const std::vector<blink::WebInputElement>& fields) {
  blink::WebElement container = ParentElement(fields.front());
  while (container) {
    if (std::ranges::all_of(fields, [&](const blink::WebInputElement& field) {
          return Inside(field, container);
        })) {
      return container;
    }
    container = ParentElement(container);
  }
  return blink::WebElement();
}

}

bool SameOriginURL(blink::WebLocalFrame* frame,
                   const blink::WebString& value,
                   const url::Origin& expected_origin) {
  const GURL destination =
      value.IsEmpty() ? GURL(frame->GetDocument().Url())
                      : GURL(frame->GetDocument().CompleteURL(value));
  return destination.is_valid() && destination.SchemeIsHTTPOrHTTPS() &&
         url::Origin::Create(destination).IsSameOriginWith(expected_origin);
}

bool FormDestinationAllowed(blink::WebLocalFrame* frame,
                            const url::Origin& expected_origin,
                            const blink::WebFormElement& form) {
  return SameOriginURL(frame, form.Action(), expected_origin) &&
         SubmitterAllowedFor(frame, expected_origin, form,
                             blink::WebFormControlElement());
}

SignInControl ChooseActivation(
    blink::WebLocalFrame* frame,
    const url::Origin& expected_origin,
    const std::vector<blink::WebInputElement>& fields,
    bool preflight) {
  SignInControl none;
  if (fields.empty()) {
    return none;
  }
  blink::WebFormElement form = fields.back().Form();
  if (form) {
    none.form = form;
    none.scope = form;
    if (!FormDestinationAllowed(frame, expected_origin, form)) {
      none.result = ControlSearch::kRefused;
      return none;
    }
    std::vector<blink::WebFormControlElement> submits;
    std::vector<blink::WebElement> candidates = ControlsIn(form);
    for (const blink::WebFormControlElement& control :
         form.GetFormControlElements()) {
      const ControlKind kind = KindOf(control);
      if (!(control.Form() == form)) {
        continue;
      }
      if (kind == ControlKind::kSubmit) {
        submits.push_back(control);
      }
      if (kind != ControlKind::kNone && !Inside(control, form)) {
        candidates.push_back(control);
      }
    }
    if (submits.size() == 1 && IsShown(submits.front()) &&
        (preflight || !Disabled(submits.front()))) {
      const std::string name = AccessibleName(frame, submits.front(), form);
      const bool icon_only =
          name.empty() &&
          !submits.front().HasAttribute(Ascii("aria-labelledby"));
      if ((icon_only || NameReadsAsSignIn(name)) &&
          UsableImage(submits.front())) {
        if (!ControlAllowed(frame, expected_origin, submits.front(),
                            ControlKind::kSubmit)) {
          none.result = ControlSearch::kRefused;
          return none;
        }
        SignInControl chosen = none;
        chosen.result = ControlSearch::kClick;
        chosen.control = submits.front();
        chosen.intent =
            Intent(frame, submits.front(), ControlKind::kSubmit, name);
        chosen.method = EffectiveMethod(form, submits.front());
        return chosen;
      }
    }
    SignInControl labelled = Labelled(frame, expected_origin, candidates,
                                      fields, form, form, preflight);
    if (labelled.result != ControlSearch::kNone || !submits.empty()) {
      return labelled;
    }
    SignInControl submit = none;
    submit.result = ControlSearch::kRequestSubmit;
    submit.method = EffectiveMethod(form, blink::WebFormControlElement());
    submit.intent = "form\n" + GURL(form.Action().IsEmpty()
                                        ? frame->GetDocument().Url()
                                        : frame->GetDocument().CompleteURL(
                                              form.Action()))
                                   .spec();
    return submit;
  }
  blink::WebElement container = CommonContainer(fields);
  for (int level = 0;
       container && !IsPageRoot(container) && level <= kMostLevelsUp;
       ++level, container = ParentElement(container)) {
    SignInControl found =
        Labelled(frame, expected_origin, ControlsIn(container), fields,
                 blink::WebFormElement(), container, preflight);
    if (found.result != ControlSearch::kNone) {
      return found;
    }
  }
  return none;
}

bool SameActivation(const SignInControl& a, const SignInControl& b) {
  return a.result == b.result && a.intent == b.intent && a.form == b.form &&
         a.scope == b.scope && a.method == b.method;
}

bool RunActivation(blink::WebLocalFrame* frame, const SignInControl& chosen) {
  auto ignore = [](v8::Isolate*, v8::Local<v8::Value>) {};
  if (chosen.result == ControlSearch::kClick && chosen.control) {
    return CallInIsolatedWorld(frame,
                               "(function (control) { control.click(); })",
                               chosen.control, ignore);
  }
  if (chosen.result == ControlSearch::kRequestSubmit && chosen.form) {
    return CallInIsolatedWorld(frame,
                               "(function (form) { form.requestSubmit(); })",
                               chosen.form, ignore);
  }
  return false;
}

}
