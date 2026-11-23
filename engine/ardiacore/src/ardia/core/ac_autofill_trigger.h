#ifndef ARDIA_CORE_AC_AUTOFILL_TRIGGER_H_
#define ARDIA_CORE_AC_AUTOFILL_TRIGGER_H_

#include <string>

#include "ardia/core/ac_autofill_fill.h"

namespace content {
class WebContents;
}

namespace ardiacore {

void TrackAutofillFocus(content::WebContents* contents);
bool ShowAutofillSuggestions(content::WebContents* contents, bool passwords);
void ClaimAutofillMenuKeys(content::WebContents* contents, bool claim);
bool FillFocusedAutofillEntry(content::WebContents* contents,
                              AutofillEntryKind kind,
                              const std::string& guid);

}

#endif
