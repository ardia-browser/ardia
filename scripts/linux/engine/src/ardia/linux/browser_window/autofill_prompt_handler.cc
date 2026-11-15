// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/browser_window/browser_window.h"

#include <utility>

#include "ardia/linux/browser_window/autofill_prompts.h"
#include "chrome/browser/ui/autofill/save_address_bubble_controller.h"
#include "chrome/browser/ui/autofill/update_address_bubble_controller.h"
#include "content/public/browser/web_contents.h"

namespace ardia_linux {

AutofillPromptHandler::AutofillPromptHandler() = default;
AutofillPromptHandler::~AutofillPromptHandler() = default;

#define AC_NO_BUBBLE(...) \
  {                       \
    return nullptr;       \
  }
autofill::AutofillBubbleBase* AutofillPromptHandler::ShowSaveCreditCardBubble(
    content::WebContents* web_contents,
    autofill::SaveCardBubbleController* controller,
    bool) {
  return ShowSaveCardPrompt(web_contents, controller);
}
autofill::AutofillBubbleBase* AutofillPromptHandler::ShowIbanBubble(
    content::WebContents* web_contents,
    autofill::IbanBubbleController*,
    bool,
    autofill::IbanBubbleType) {
  return SkipIbanBubble(web_contents);
}
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowOfferNotificationBubble(content::WebContents* web_contents,
                                autofill::OfferNotificationBubbleController*,
                                bool) {
  return SkipOfferNotification(web_contents);
}
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowSaveAutofillAiDataBubble(content::WebContents*,
                                 autofill::AutofillAiImportDataController*)
        AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowAutofillAiLocalSaveNotification(
        content::WebContents*,
        autofill::AutofillAiImportDataController*) AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowSaveAddressProfileBubble(
        content::WebContents* web_contents,
        std::unique_ptr<autofill::SaveAddressBubbleController> controller,
        bool) {
  return ShowSaveAddressPrompt(web_contents, std::move(controller));
}
#if BUILDFLAG(ENABLE_DICE_SUPPORT)
autofill::AutofillBubbleBase* AutofillPromptHandler::ShowAddressSignInPromo(
    content::WebContents* web_contents,
    const autofill::AutofillProfile&) {
  return SkipAddressSignInPromo(web_contents);
}
#endif
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowUpdateAddressProfileBubble(
        content::WebContents* web_contents,
        std::unique_ptr<autofill::UpdateAddressBubbleController> controller,
        bool) {
  return ShowUpdateAddressPrompt(web_contents, std::move(controller));
}
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowFilledCardInformationBubble(
        content::WebContents*,
        autofill::FilledCardInformationBubbleController*,
        bool) AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowVirtualCardEnrollBubble(content::WebContents*,
                                autofill::VirtualCardEnrollBubbleController*,
                                bool) AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowVirtualCardEnrollConfirmationBubble(
        content::WebContents*,
        autofill::VirtualCardEnrollBubbleController*) AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowMandatoryReauthBubble(content::WebContents*,
                              autofill::MandatoryReauthBubbleController*,
                              bool,
                              autofill::MandatoryReauthBubbleType)
        AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowSaveCardConfirmationBubble(
        content::WebContents* web_contents,
        autofill::SaveCardBubbleController* controller) {
  return ShowSaveCardPrompt(web_contents, controller);
}
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowSaveIbanConfirmationBubble(content::WebContents*,
                                   autofill::IbanBubbleController*)
        AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowOmniboxAutofillBubble(content::WebContents*,
                              autofill::OmniboxAutofillBubbleController*)
        AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowPaymentsChurnedUsersBubble(
        content::WebContents*,
        autofill::PaymentsChurnedUsersBubbleController*,
        bool) AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowPaymentsChurnedUsersConfirmationBubble(
        content::WebContents*,
        autofill::PaymentsChurnedUsersBubbleController*) AC_NO_BUBBLE()
autofill::AutofillBubbleBase* AutofillPromptHandler::
    ShowWalletReminderNoticeBubble(
        content::WebContents*,
        autofill::WalletReminderNoticeBubbleController*,
        bool) AC_NO_BUBBLE()
#undef AC_NO_BUBBLE

}
