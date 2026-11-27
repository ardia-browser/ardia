#import "ardia/core/public/ArdiaCore.h"

#include <objc/runtime.h>

#include "base/containers/span.h"
#include "base/strings/sys_string_conversions.h"
#include "components/autofill/core/browser/suggestions/suggestion.h"
#include "components/autofill/core/browser/suggestions/suggestion_type.h"
#include "components/password_manager/content/browser/content_password_manager_driver.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "ardia/core/ac_browser.h"
#include "ardia/core/ac_mac_hooks.h"

namespace ardiacore {

namespace {

char kSuppressedAutofillKinds;
char kSuppressedAutofillLogins;

NSString* AutofillKindOf(autofill::SuggestionType type) {
  if (type == autofill::SuggestionType::kSeparator ||
      type == autofill::SuggestionType::kTitle ||
      type == autofill::SuggestionType::kLoadingThrobber ||
      type == autofill::SuggestionType::kUndo) {
    return nil;
  }
  NSString* name =
      base::SysUTF8ToNSString(autofill::SuggestionTypeToString(type));
  if ([name containsString:@"Webauthn"] || [name containsString:@"Passkey"]) {
    return @"passkey";
  }
  if ([name containsString:@"Password"]) {
    return @"login";
  }
  if ([name isEqualToString:@"kAutocompleteEntry"]) {
    return @"history";
  }
  if ([name containsString:@"CreditCard"] || [name containsString:@"Iban"]) {
    return @"card";
  }
  if ([name containsString:@"Address"]) {
    return @"address";
  }
  return @"other";
}

bool SuggestionsClaimed(content::WebContents* contents,
                        base::span<const autofill::Suggestion> suggestions) {
  TabBridge* bridge = contents ? TabBridge::FromWebContents(contents) : nullptr;
  NSSet<NSString*>* claimed =
      bridge ? objc_getAssociatedObject(bridge->tab(), &kSuppressedAutofillKinds)
             : nil;
  if (!claimed.count) {
    return false;
  }
  NSSet<NSString*>* logins =
      objc_getAssociatedObject(bridge->tab(), &kSuppressedAutofillLogins);
  bool any = false;
  for (const autofill::Suggestion& suggestion : suggestions) {
    NSString* kind = AutofillKindOf(suggestion.type);
    if (!kind) {
      continue;
    }
    if (![claimed containsObject:kind]) {
      return false;
    }
    bool saved_login =
        suggestion.type == autofill::SuggestionType::kPasswordEntry ||
        suggestion.type == autofill::SuggestionType::kAccountStoragePasswordEntry;
    if (saved_login && logins &&
        ![logins containsObject:base::SysUTF16ToNSString(
                                    suggestion.main_text.value)
                                    .lowercaseString]) {
      return false;
    }
    any = true;
  }
  return any;
}

bool PasswordFillingAllowed(content::WebContents* contents) {
  TabBridge* bridge = contents ? TabBridge::FromWebContents(contents) : nullptr;
  if (!bridge) {
    return true;
  }
  NSSet<NSString*>* claimed =
      objc_getAssociatedObject(bridge->tab(), &kSuppressedAutofillKinds);
  bool every_login = ![bridge->tab() suppressedAutofillLogins];
  return !([claimed containsObject:@"login"] && every_login);
}

bool PasswordGenerationAllowed(
    const password_manager::PasswordManagerDriver* driver) {
  const auto* content_driver =
      static_cast<const password_manager::ContentPasswordManagerDriver*>(driver);
  content::RenderFrameHost* frame =
      content_driver ? content_driver->render_frame_host() : nullptr;
  return PasswordFillingAllowed(
      frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr);
}

}

}

@implementation ArdiaCoreTab (AutofillSuppression)

- (NSSet<NSString*>*)suppressedAutofillKinds {
  return objc_getAssociatedObject(self, &ardiacore::kSuppressedAutofillKinds)
             ?: [NSSet set];
}

- (void)setSuppressedAutofillKinds:(NSSet<NSString*>*)kinds {
  autofill::g_ardia_autofill_suggestions_suppressed =
      &ardiacore::SuggestionsClaimed;
  g_ardia_password_filling_allowed = &ardiacore::PasswordFillingAllowed;
  password_manager::g_ardia_password_generation_allowed =
      &ardiacore::PasswordGenerationAllowed;
  objc_setAssociatedObject(self, &ardiacore::kSuppressedAutofillKinds, kinds,
                           OBJC_ASSOCIATION_COPY_NONATOMIC);
}

- (NSSet<NSString*>*)suppressedAutofillLogins {
  return objc_getAssociatedObject(self, &ardiacore::kSuppressedAutofillLogins);
}

- (void)setSuppressedAutofillLogins:(NSSet<NSString*>*)logins {
  objc_setAssociatedObject(self, &ardiacore::kSuppressedAutofillLogins, logins,
                           OBJC_ASSOCIATION_COPY_NONATOMIC);
}

@end
