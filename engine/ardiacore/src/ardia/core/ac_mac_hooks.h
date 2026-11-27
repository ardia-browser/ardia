#ifndef ARDIA_CORE_AC_MAC_HOOKS_H_
#define ARDIA_CORE_AC_MAC_HOOKS_H_

#include "base/containers/span.h"

namespace autofill {
struct Suggestion;
}

namespace content {
class WebContents;
}

namespace password_manager {
class PasswordManagerDriver;
}

namespace autofill {
extern bool (*g_ardia_autofill_suggestions_suppressed)(
    content::WebContents* web_contents,
    base::span<const Suggestion> suggestions);
}

extern bool (*g_ardia_password_filling_allowed)(content::WebContents* web_contents);

namespace password_manager {
extern bool (*g_ardia_password_generation_allowed)(
    const PasswordManagerDriver* driver);
extern bool (*g_ardia_password_submissions_prompted)(
    const PasswordManagerDriver* driver);
}

#endif
