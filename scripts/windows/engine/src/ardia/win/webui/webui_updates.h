#ifndef ARDIA_WIN_WEBUI_WEBUI_UPDATES_H_
#define ARDIA_WIN_WEBUI_WEBUI_UPDATES_H_

#include <string_view>

#include "base/functional/callback.h"
#include "base/values.h"

namespace ardia_win::webui {

inline constexpr std::string_view kUpdateCapabilities[] = {
    "ArdiaUpdates.installKind", "ArdiaUpdates.update",  "ArdiaUpdates.status",
    "ArdiaUpdates.claimOutcome", "ArdiaUpdates.restart", "ArdiaUpdates.check",
};

using UpdateReply = base::OnceCallback<void(bool, base::Value)>;

bool HandlesUpdateCall(std::string_view method);

void InvokeUpdates(std::string_view method,
                   const base::Value* args,
                   UpdateReply done,
                   base::OnceClosure quit);

}

#endif
