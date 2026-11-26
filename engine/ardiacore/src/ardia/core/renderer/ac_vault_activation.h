#ifndef ARDIA_CORE_RENDERER_AC_VAULT_ACTIVATION_H_
#define ARDIA_CORE_RENDERER_AC_VAULT_ACTIVATION_H_

#include <string>
#include <vector>

#include "ardia/core/renderer/ac_vault_page_state.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_element.h"
#include "third_party/blink/public/web/web_form_control_element.h"
#include "third_party/blink/public/web/web_form_element.h"
#include "third_party/blink/public/web/web_input_element.h"
#include "third_party/blink/public/web/web_node.h"
#include "url/origin.h"

namespace blink {
class WebDocument;
class WebLocalFrame;
}

namespace ardiacore {

enum class ControlSearch { kClick, kRequestSubmit, kNone, kAmbiguous, kRefused };

struct SignInControl {
  ControlSearch result = ControlSearch::kNone;
  blink::WebElement control;
  blink::WebFormElement form;
  blink::WebElement scope;
  std::string intent;
  std::string method;
};

bool SameOriginURL(blink::WebLocalFrame* frame,
                   const blink::WebString& value,
                   const url::Origin& expected_origin);
bool FormDestinationAllowed(blink::WebLocalFrame* frame,
                            const url::Origin& expected_origin,
                            const blink::WebFormElement& form);
SignInControl ChooseActivation(
    blink::WebLocalFrame* frame,
    const url::Origin& expected_origin,
    const std::vector<blink::WebInputElement>& fields,
    bool preflight);
bool SameActivation(const SignInControl& a, const SignInControl& b);
bool RunActivation(blink::WebLocalFrame* frame, const SignInControl& chosen);

}

#endif
