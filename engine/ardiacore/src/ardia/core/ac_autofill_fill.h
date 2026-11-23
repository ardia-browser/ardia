#ifndef ARDIA_CORE_AC_AUTOFILL_FILL_H_
#define ARDIA_CORE_AC_AUTOFILL_FILL_H_

#include <string>

#import <Foundation/Foundation.h>

#include "components/autofill/core/common/unique_ids.h"

namespace autofill {
class AutofillManager;
}

namespace content {
class WebContents;
}

namespace ardiacore {

enum class AutofillEntryKind { kAddress, kCard };

void ReportAutofillField(content::WebContents* contents,
                         autofill::AutofillManager& manager,
                         const autofill::FormGlobalId& form,
                         const autofill::FieldGlobalId& field,
                         bool asked);
void ReportAutofillFieldLeft(content::WebContents* contents);
void ReportAutofillMenuKey(content::WebContents* contents, NSString* key);
bool FillAutofillEntry(content::WebContents* contents,
                       autofill::AutofillManager& manager,
                       const autofill::FormGlobalId& form,
                       const autofill::FieldGlobalId& field,
                       AutofillEntryKind kind,
                       const std::string& guid);

}

#endif
