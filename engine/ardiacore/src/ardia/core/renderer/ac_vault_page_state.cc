#include "ardia/core/renderer/ac_vault_page_state.h"

#include <algorithm>
#include <initializer_list>
#include <string>
#include <string_view>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "third_party/blink/public/mojom/forms/form_control_type.mojom-shared.h"
#include "third_party/blink/public/web/web_document.h"
#include "third_party/blink/public/web/web_form_control_element.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "ui/gfx/geometry/rect.h"

namespace ardiacore {

namespace {

blink::WebString Ascii(std::string_view text) {
  return blink::WebString::FromAscii(std::string(text));
}

std::string Lower(const blink::WebString& value) {
  return base::ToLowerASCII(
      base::TrimWhitespaceASCII(value.Utf8(), base::TRIM_ALL));
}

bool ContainsAny(const std::string& text,
                 std::initializer_list<std::string_view> words) {
  return std::ranges::any_of(words, [&](std::string_view word) {
    return text.find(word) != std::string::npos;
  });
}

blink::WebElement ParentElement(const blink::WebNode& node) {
  blink::WebNode parent = node.ParentNode();
  return !parent.IsNull() && parent.IsElementNode()
             ? parent.To<blink::WebElement>()
             : blink::WebElement();
}

bool HiddenByAncestor(const blink::WebElement& element) {
  int steps = 0;
  for (blink::WebElement step = element; step && steps < 32;
       step = ParentElement(step), ++steps) {
    if (Lower(step.GetAttribute(Ascii("aria-hidden"))) == "true") {
      return true;
    }
  }
  return false;
}


std::string ClassErrors(const blink::WebNode& root) {
  std::string text;
  if (root.IsNull()) {
    return text;
  }
  for (blink::WebElement element : root.QuerySelectorAll(
           Ascii("[class*=error i], [id*=error i], [data-test*=error i], "
                 "[class*=alert-danger i], [class*=invalid-feedback i], "
                 "[aria-invalid=true i]"))) {
    if (!IsShown(element)) {
      continue;
    }
    if (Lower(element.GetAttribute(Ascii("aria-invalid"))) == "true") {
      text += "invalid:" + element.GetAttribute(Ascii("name")).Utf8() + "\n";
      continue;
    }
    const std::string content(
        base::TrimWhitespaceASCII(element.TextContent().Utf8(), base::TRIM_ALL));
    if (!content.empty()) {
      text += content.substr(0, 200) + "\n";
    }
  }
  return text;
}


std::string AlertErrors(const blink::WebDocument& document) {
  std::string text;
  for (blink::WebElement element : document.QuerySelectorAll(
           Ascii("[role=alert i], [aria-live=assertive i], "
                 "[aria-live=polite i]"))) {
    if (!IsShown(element)) {
      continue;
    }
    const std::string content = base::ToLowerASCII(
        base::TrimWhitespaceASCII(element.TextContent().Utf8(), base::TRIM_ALL));
    if (ContainsAny(content,
                    {"invalid", "incorrect", "wrong", "error", "fail",
                     "not match", "doesn't match", "does not match",
                     "try again", "locked", "denied", "unable",
                     "not recognized", "not recognised", "not found"})) {
      text += content.substr(0, 200) + "\n";
    }
  }
  return text;
}


bool Fresh(const std::string& now, const std::string& before) {
  return !now.empty() && now != before;
}


bool KeepsAtEdge(char16_t c) {
  return base::IsAsciiAlphaNumeric(c) || (c >= 0xC0 && c < 0x2000);
}

}

std::string NormalizedName(const std::u16string& name) {
  size_t begin = 0;
  size_t end = name.size();
  while (begin < end && !KeepsAtEdge(name[begin])) {
    ++begin;
  }
  while (end > begin && !KeepsAtEdge(name[end - 1])) {
    --end;
  }
  return base::ToLowerASCII(base::CollapseWhitespaceASCII(
      base::UTF16ToUTF8(name.substr(begin, end - begin)), true));
}


bool NameReadsAsSignIn(const std::string& name) {
  static constexpr std::string_view kPhrases[] = {
      "sign in",        "signin",         "log in",       "login",
      "log on",         "logon",          "sign on",      "continue",
      "next",           "submit",         "sign me in",   "log me in",
      "verify",         "verify code",    "submit code",  "confirm",
      "confirm code",   "verify and continue", "continue to sign in",
      "go",             "sign in now",    "log in now",   "login now",
      "anmelden",       "einloggen",      "connexion",    "se connecter",
      "s'identifier",   "iniciar sesión", "iniciar sesion", "entrar",
      "acceder",        "accedi",         "inloggen",     "aanmelden",
      "zaloguj się",    "zaloguj",        "logga in",     "weiter",
      "suivant",        "siguiente",      "avanti",       "volgende"};
  return std::ranges::find(kPhrases, name) != std::end(kPhrases);
}



bool IsShown(blink::WebElement element) {
  if (element.BoundsInWidget().IsEmpty() || HiddenByAncestor(element)) {
    return false;
  }
  const std::string visibility =
      Lower(element.GetComputedValue(Ascii("visibility")));
  double opacity = 1;
  if (!base::StringToDouble(Lower(element.GetComputedValue(Ascii("opacity"))),
                            &opacity)) {
    opacity = 1;
  }
  if (visibility == "hidden" || visibility == "collapse" || opacity <= 0) {
    return false;
  }
  int steps = 0;
  for (blink::WebElement step = ParentElement(element); step && steps < 32;
       step = ParentElement(step), ++steps) {
    double ancestor_opacity = 1;
    if (base::StringToDouble(Lower(step.GetComputedValue(Ascii("opacity"))),
                             &ancestor_opacity) &&
        ancestor_opacity <= 0) {
      return false;
    }
  }
  return true;
}


int PasswordFieldsIn(const blink::WebFormElement& form) {
  int passwords = 0;
  for (const blink::WebFormControlElement& control :
       form.GetFormControlElements()) {
    if (control.FormControlTypeForAutofill() ==
        blink::mojom::FormControlType::kInputPassword) {
      ++passwords;
    }
  }
  return passwords;
}


ErrorBaseline Errors(const blink::WebDocument& document,
                     const blink::WebElement& scope,
                     const blink::WebElement& around) {
  ErrorBaseline baseline;
  baseline.scope = ClassErrors(scope ? blink::WebNode(scope)
                                     : blink::WebNode(document));
  baseline.around = around ? ClassErrors(around) : std::string();
  baseline.alerts = AlertErrors(document);
  return baseline;
}


bool NewError(const ErrorBaseline& before,
              const blink::WebDocument& document,
              const blink::WebElement& scope,
              const blink::WebElement& around,
              bool scoped) {
  if (!scoped) {
    return !ClassErrors(document).empty() || !AlertErrors(document).empty();
  }
  if (scope && scope.IsConnected()) {
    if (Fresh(ClassErrors(scope), before.scope)) {
      return true;
    }
  } else if (around && around.IsConnected() &&
             Fresh(ClassErrors(around), before.around)) {
    return true;
  }
  return Fresh(AlertErrors(document), before.alerts);
}


int PasswordsIn(const blink::WebNode& root) {
  int passwords = 0;
  if (root.IsNull()) {
    return passwords;
  }
  for (blink::WebElement element : root.QuerySelectorAll(Ascii("input"))) {
    blink::WebFormControlElement control =
        element.DynamicTo<blink::WebFormControlElement>();
    if (control && control.FormControlTypeForAutofill() ==
                       blink::mojom::FormControlType::kInputPassword) {
      ++passwords;
    }
  }
  return passwords;
}

bool ReadsAsNotLogin(const blink::WebElement& scope,
                     const blink::WebElement& around) {
  auto text_of = [](const blink::WebElement& element) {
    return base::ToLowerASCII(base::CollapseWhitespaceASCII(
        element.TextContent().Utf8(), true));
  };
  for (const blink::WebElement& root : {scope, around}) {
    if (root.IsNull()) {
      continue;
    }
    for (blink::WebElement heading : root.QuerySelectorAll(
             Ascii("h1, h2, h3, h4, h5, h6, legend, [role=heading i]"))) {
      if (ContainsAny(text_of(heading),
                      {"reset", "forgot", "change password", "new password",
                       "set password", "set a password", "choose a password",
                       "create a password", "create password"})) {
        return true;
      }
    }
  }
  if (scope.IsNull()) {
    return false;
  }
  for (blink::WebElement label : scope.QuerySelectorAll(Ascii("label"))) {
    if (ContainsAny(text_of(label), {"new password", "confirm password",
                                     "repeat password", "retype password",
                                     "re-enter password"})) {
      return true;
    }
  }
  bool sign_up = false;
  bool sign_in = false;
  for (blink::WebElement button : scope.QuerySelectorAll(
           Ascii("button, input[type=submit i], input[type=button i]"))) {
    const std::string name =
        button.HasHTMLTagName(Ascii("input"))
            ? base::ToLowerASCII(button.GetAttribute(Ascii("value")).Utf8())
            : text_of(button);
    if (ContainsAny(name, {"reset", "change password", "set password",
                           "update password", "save password",
                           "create password"})) {
      return true;
    }
    sign_up |= ContainsAny(name, {"sign up", "signup", "register",
                                  "create account", "create an account",
                                  "create my account", "join"});
    sign_in |= ContainsAny(name, {"sign in", "signin", "log in", "login",
                                  "log on", "logon"});
  }
  if (sign_up && !sign_in) {
    return true;
  }
  std::string attributes;
  for (const char* attribute : {"id", "name", "class", "action"}) {
    attributes += Lower(scope.GetAttribute(Ascii(attribute))) + " ";
  }
  return ContainsAny(attributes, {"reset", "forgot", "signup", "sign-up",
                                  "sign_up", "register", "change-password",
                                  "change_password", "new-password",
                                  "new_password"});
}

bool CodeFieldShown(const blink::WebDocument& document) {
  for (blink::WebElement element : document.QuerySelectorAll(Ascii("input"))) {
    blink::WebInputElement input = element.DynamicTo<blink::WebInputElement>();
    if (!input || !input.IsTextField() || !IsShown(element) ||
        input.FormControlTypeForAutofill() ==
            blink::mojom::FormControlType::kInputPassword) {
      continue;
    }
    if (Lower(element.GetAttribute(Ascii("autocomplete")))
            .find("one-time-code") != std::string::npos) {
      return true;
    }
    std::string names;
    for (const char* attribute : {"name", "id", "aria-label", "placeholder"}) {
      names += Lower(element.GetAttribute(Ascii(attribute))) + " ";
    }
    if (ContainsAny(names, {"otp", "2fa", "mfa", "totp", "one-time",
                            "onetime", "verification", "passcode", "authcode",
                            "security code", "security-code"})) {
      return true;
    }
    int max_length = 0;
    if (Lower(element.GetAttribute(Ascii("inputmode"))) == "numeric" &&
        base::StringToInt(Lower(element.GetAttribute(Ascii("maxlength"))),
                          &max_length) &&
        max_length >= 4 && max_length <= 8) {
      return true;
    }
  }
  return false;
}


bool ChallengeShown(const blink::WebDocument& document) {
  for (blink::WebElement element : document.QuerySelectorAll(Ascii("iframe"))) {
    const std::string source = Lower(element.GetAttribute(Ascii("src")));
    if (IsShown(element) &&
        ContainsAny(source, {"recaptcha/api2/bframe",
                             "recaptcha/enterprise/bframe", "hcaptcha.com",
                             "challenges.cloudflare.com", "arkoselabs",
                             "funcaptcha"})) {
      return true;
    }
  }
  for (blink::WebElement element : document.QuerySelectorAll(
           Ascii("[class*=cf-turnstile i], [class*=h-captcha i]"))) {
    if (IsShown(element)) {
      return true;
    }
  }
  return false;
}


blink::WebElement ElementAbove(const blink::WebNode& node) {
  blink::WebNode parent = node.ParentOrShadowHostNode();
  return !parent.IsNull() && parent.IsElementNode()
             ? parent.To<blink::WebElement>()
             : blink::WebElement();
}


bool AnyShown(const blink::WebDocument& document,
                     const char* selector) {
  for (blink::WebElement element :
       document.QuerySelectorAll(blink::WebString::FromAscii(selector))) {
    if (IsShown(element)) {
      return true;
    }
  }
  return false;
}


bool ReadsAsCodeField(const blink::WebInputElement& code,
                      const blink::WebElement& scope) {
  const std::string autocomplete =
      Lower(code.GetAttribute(Ascii("autocomplete")));
  if (autocomplete.find("one-time-code") != std::string::npos) {
    return true;
  }
  int max_length = 0;
  if (Lower(code.GetAttribute(Ascii("inputmode"))) == "numeric" &&
      base::StringToInt(Lower(code.GetAttribute(Ascii("maxlength"))),
                        &max_length) &&
      max_length >= 4 && max_length <= 8) {
    return true;
  }
  std::string names;
  for (const char* attribute : {"name", "id", "aria-label", "placeholder"}) {
    names += Lower(code.GetAttribute(Ascii(attribute))) + " ";
  }
  const blink::WebString id = code.GetAttribute(Ascii("id"));
  if (scope && !id.IsEmpty()) {
    for (blink::WebElement label : scope.QuerySelectorAll(Ascii("label"))) {
      if (label.GetAttribute(Ascii("for")) == id) {
        names += Lower(label.TextContent()) + " ";
      }
    }
  }
  return ContainsAny(names, {"code", "otp", "verification", "2fa", "mfa",
                             "passcode", "one-time", "onetime"});
}

bool CodeStillVerifies(const blink::WebInputElement& code,
                              const blink::WebFormElement& owner,
                              const blink::WebElement& scope,
                              const blink::WebElement& around) {
  return code.IsConnected() && code.IsTextField() &&
         code.FormControlTypeForAutofill() !=
             blink::mojom::FormControlType::kInputPassword &&
         Lower(code.GetAttribute(Ascii("autocomplete"))).find("new-password") ==
             std::string::npos &&
         code.Form() == owner && ReadsAsCodeField(code, scope) &&
         !ReadsAsNotLogin(scope, around);
}


bool IsLogin(const blink::WebInputElement& password,
                    const blink::WebFormElement& owner,
                    const blink::WebElement& scope,
                    const blink::WebElement& around) {
  if (!password.IsConnected() ||
      password.FormControlTypeForAutofill() !=
          blink::mojom::FormControlType::kInputPassword ||
      base::ToLowerASCII(password
                             .GetAttribute(blink::WebString::FromAscii(
                                 "autocomplete"))
                             .Utf8())
              .find("new-password") != std::string::npos ||
      !(password.Form() == owner)) {
    return false;
  }
  const int passwords = owner   ? PasswordFieldsIn(owner)
                        : scope ? PasswordsIn(scope)
                                : 1;
  return passwords == 1 && !ReadsAsNotLogin(scope, around);
}

}
