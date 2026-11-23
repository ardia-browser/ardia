#include "ardia/core/ac_autofill_fill.h"

#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/task/single_thread_task_runner.h"
#include "components/autofill/core/browser/data_manager/addresses/address_data_manager.h"
#include "components/autofill/core/browser/data_manager/payments/payments_data_manager.h"
#include "components/autofill/core/browser/data_manager/personal_data_manager.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile.h"
#include "components/autofill/core/browser/data_model/payments/credit_card.h"
#include "components/autofill/core/browser/field_types.h"
#include "components/autofill/core/browser/form_structure.h"
#include "components/autofill/core/browser/foundations/autofill_client.h"
#include "components/autofill/core/browser/foundations/autofill_driver.h"
#include "components/autofill/core/browser/foundations/browser_autofill_manager.h"
#include "components/autofill/core/common/aliases.h"
#include "components/autofill/core/common/mojom/autofill_types.mojom-shared.h"
#include "content/public/browser/web_contents.h"
#include "ardia/core/ac_browser.h"
#import "ardia/core/ardiacore_internal.h"

namespace ardiacore {

namespace {

using autofill::FieldType;
using autofill::FieldTypeGroup;

NSString* AddressPart(const autofill::AutofillField& field) {
  switch (field.Type().GetStorableType()) {
    case autofill::ADDRESS_HOME_CITY:
      return @"city";
    case autofill::ADDRESS_HOME_STATE:
      return @"state";
    case autofill::ADDRESS_HOME_ZIP:
      return @"postalCode";
    case autofill::ADDRESS_HOME_COUNTRY:
      return @"country";
    default:
      return @"street";
  }
}

NSString* CardPart(const autofill::AutofillField& field) {
  switch (field.Type().GetStorableType()) {
    case autofill::CREDIT_CARD_NUMBER:
      return @"number";
    case autofill::CREDIT_CARD_NAME_FULL:
    case autofill::CREDIT_CARD_NAME_FIRST:
    case autofill::CREDIT_CARD_NAME_LAST:
      return @"name";
    case autofill::CREDIT_CARD_VERIFICATION_CODE:
      return @"cvc";
    default:
      return @"expiry";
  }
}

NSDictionary* Describe(const autofill::AutofillField& field) {
  switch (field.Type().group()) {
    case FieldTypeGroup::kName:
      return @{@"kind" : @"address", @"part" : @"name"};
    case FieldTypeGroup::kEmail:
      return @{@"kind" : @"address", @"part" : @"email"};
    case FieldTypeGroup::kPhone:
      return @{@"kind" : @"address", @"part" : @"phone"};
    case FieldTypeGroup::kCompany:
      return @{@"kind" : @"address", @"part" : @"organization"};
    case FieldTypeGroup::kAddress:
      return @{@"kind" : @"address", @"part" : AddressPart(field)};
    case FieldTypeGroup::kCreditCard:
      return @{@"kind" : @"card", @"part" : CardPart(field)};
    default:
      return nil;
  }
}

void Tell(content::WebContents* contents, NSDictionary* payload, SEL selector) {
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> contents, NSDictionary* payload,
             SEL selector) {
            if (!contents) {
              return;
            }
            ArdiaCoreTab* tab = TabBridge::GetOrCreate(contents.get())->tab();
            id<ArdiaCoreTabDelegate> delegate = tab.delegate;
            if (selector == @selector(tab:didPressAutofillMenuKey:)) {
              if ([delegate respondsToSelector:selector]) {
                [delegate tab:tab didPressAutofillMenuKey:payload[@"key"]];
              }
            } else if ([delegate respondsToSelector:@selector(tab:didFocusAutofillField:)]) {
              [delegate tab:tab didFocusAutofillField:payload];
            }
          },
          contents->GetWeakPtr(), payload, selector));
}

}

void ReportAutofillField(content::WebContents* contents,
                         autofill::AutofillManager& manager,
                         const autofill::FormGlobalId& form,
                         const autofill::FieldGlobalId& field,
                         bool asked) {
  if (!contents) {
    return;
  }
  autofill::FormStructure* structure = manager.FindCachedFormById(form);
  autofill::AutofillField* autofill_field =
      structure ? structure->GetFieldById(field) : nullptr;
  NSDictionary* described = autofill_field ? Describe(*autofill_field) : nil;
  if (!described) {
    return ReportAutofillFieldLeft(contents);
  }
  const gfx::RectF box = manager.driver().TransformBoundingBoxToViewportCoordinates(
      autofill_field->bounds());
  NSMutableDictionary* payload = [described mutableCopy];
  payload[@"focused"] = @YES;
  payload[@"trigger"] = asked ? @"ask" : @"focus";
  payload[@"rect"] = @{
    @"x" : @(box.x()),
    @"y" : @(box.y()),
    @"width" : @(box.width()),
    @"height" : @(box.height()),
  };
  Tell(contents, payload, @selector(tab:didFocusAutofillField:));
}

void ReportAutofillFieldLeft(content::WebContents* contents) {
  if (contents) {
    Tell(contents, @{@"focused" : @NO}, @selector(tab:didFocusAutofillField:));
  }
}

void ReportAutofillMenuKey(content::WebContents* contents, NSString* key) {
  if (contents && key) {
    Tell(contents, @{@"key" : key}, @selector(tab:didPressAutofillMenuKey:));
  }
}

bool FillAutofillEntry(content::WebContents* contents,
                       autofill::AutofillManager& manager,
                       const autofill::FormGlobalId& form,
                       const autofill::FieldGlobalId& field,
                       AutofillEntryKind kind,
                       const std::string& guid) {
  autofill::FormStructure* structure = manager.FindCachedFormById(form);
  if (!contents || !structure || !structure->GetFieldById(field)) {
    return false;
  }
  auto& browser_manager =
      static_cast<autofill::BrowserAutofillManager&>(manager);
  autofill::PersonalDataManager& pdm =
      manager.client().GetPersonalDataManager();
  const autofill::FormData data = structure->ToFormData();
  if (kind == AutofillEntryKind::kAddress) {
    const autofill::AutofillProfile* profile =
        pdm.address_data_manager().GetProfileByGUID(guid);
    if (!profile) {
      return false;
    }
    browser_manager.FillOrPreviewForm(
        autofill::mojom::ActionPersistence::kFill, data, field, profile,
        autofill::AutofillTriggerSource::kPopup);
    return true;
  }
  const autofill::CreditCard* card =
      pdm.payments_data_manager().GetCreditCardByGUID(guid);
  if (!card ||
      card->record_type() != autofill::CreditCard::RecordType::kLocalCard) {
    return false;
  }
  browser_manager.FillOrPreviewForm(autofill::mojom::ActionPersistence::kFill,
                                    data, field, card,
                                    autofill::AutofillTriggerSource::kPopup);
  return true;
}

}
