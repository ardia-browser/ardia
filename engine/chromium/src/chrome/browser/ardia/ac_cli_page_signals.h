// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PAGE_SIGNALS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PAGE_SIGNALS_H_

#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/types/expected.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace ardia {

using PageSignalReply =
    base::OnceCallback<void(base::expected<base::DictValue, std::string>)>;

bool IsPageSignalMethod(std::string_view method);

base::ScopedClosureRunner RunPageSignal(std::string_view method,
                                        const base::DictValue& params,
                                        content::WebContents* contents,
                                        PageSignalReply reply);

base::DictValue PageSignalTotals();

}

#endif
