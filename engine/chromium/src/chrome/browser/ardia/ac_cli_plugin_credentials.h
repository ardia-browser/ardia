// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_CREDENTIALS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PLUGIN_CREDENTIALS_H_

#include <optional>
#include <string>
#include <string_view>

#include "chrome/browser/ardia/ac_cli_token_policy.h"

namespace ardia {

struct MintedPluginCredential {
  std::string id;
  std::string secret;
};

std::optional<MintedPluginCredential> MintPluginCredential(PluginScope scope);
bool RevokePluginCredential(const std::string& id);
bool PluginCredentialLive(const std::string& id);
void ClearPluginCredentials();
std::optional<PluginScope> PluginScopeForSecret(std::string_view secret);
std::optional<PluginScope> PluginScopeForId(const std::string& id);
std::string TokenServerEndpoint();

}

#endif
