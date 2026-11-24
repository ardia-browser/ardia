// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_H_

#include <memory>

#include "ardia/core/ac_content_hooks.h"
#include "base/values.h"

namespace content {
class DevToolsAgentHost;
class DevToolsAgentHostClient;
}

namespace ardia {

std::unique_ptr<ArdiaDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host);

bool IsTokenClient(content::DevToolsAgentHostClient* root_client);

base::DictValue TokenCommandTotals();

}

#endif
