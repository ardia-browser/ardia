#ifndef ARDIA_CORE_RENDERER_AC_VAULT_PAGE_STATE_H_
#define ARDIA_CORE_RENDERER_AC_VAULT_PAGE_STATE_H_

#include <string>

#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_form_element.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "third_party/blink/public/web/web_node.h"

namespace blink {
class WebDocument;
}

namespace ardiacore {

struct ErrorBaseline {
  std::string scope;
  std::string around;
  std::string alerts;
};

std::string NormalizedName(const std::u16string& name);
bool NameReadsAsSignIn(const std::string& name);
bool IsShown(blink::WebElement element);
blink::WebElement ElementAbove(const blink::WebNode& node);
bool AnyShown(const blink::WebDocument& document, const char* selector);
bool CodeStillVerifies(const blink::WebInputElement& code,
                       const blink::WebFormElement& owner,
                       const blink::WebElement& scope,
                       const blink::WebElement& around);
bool IsLogin(const blink::WebInputElement& password,
             const blink::WebFormElement& owner,
             const blink::WebElement& scope,
             const blink::WebElement& around);
int PasswordFieldsIn(const blink::WebFormElement& form);
int PasswordsIn(const blink::WebNode& root);
bool ReadsAsNotLogin(const blink::WebElement& scope,
                     const blink::WebElement& around);
ErrorBaseline Errors(const blink::WebDocument& document,
                     const blink::WebElement& scope,
                     const blink::WebElement& around);
bool NewError(const ErrorBaseline& before,
              const blink::WebDocument& document,
              const blink::WebElement& scope,
              const blink::WebElement& around,
              bool scoped);
bool CodeFieldShown(const blink::WebDocument& document);
bool ChallengeShown(const blink::WebDocument& document);

}

#endif
