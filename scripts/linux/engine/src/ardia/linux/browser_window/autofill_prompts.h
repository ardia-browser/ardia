// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_BROWSER_WINDOW_AUTOFILL_PROMPTS_H_
#define ARDIA_LINUX_BROWSER_WINDOW_AUTOFILL_PROMPTS_H_

#include <memory>
#include <optional>
#include <string>

#include "base/values.h"

namespace autofill {
class AutofillBubbleBase;
class SaveAddressBubbleController;
class SaveCardBubbleController;
class UpdateAddressBubbleController;
}

namespace content {
class WebContents;
}

namespace ardia_linux {

autofill::AutofillBubbleBase* ShowSaveAddressPrompt(
    content::WebContents* contents,
    std::unique_ptr<autofill::SaveAddressBubbleController> controller);
autofill::AutofillBubbleBase* ShowUpdateAddressPrompt(
    content::WebContents* contents,
    std::unique_ptr<autofill::UpdateAddressBubbleController> controller);
autofill::AutofillBubbleBase* ShowSaveCardPrompt(
    content::WebContents* contents,
    autofill::SaveCardBubbleController* controller);
autofill::AutofillBubbleBase* SkipIbanBubble(content::WebContents* contents);
autofill::AutofillBubbleBase* SkipOfferNotification(
    content::WebContents* contents);
autofill::AutofillBubbleBase* SkipAddressSignInPromo(
    content::WebContents* contents);

std::optional<base::DictValue> PendingAutofillPrompt(
    content::WebContents* contents);
bool ResolveAutofillPrompt(content::WebContents* contents,
                           int prompt_id,
                           const std::string& answer);

}

#endif
