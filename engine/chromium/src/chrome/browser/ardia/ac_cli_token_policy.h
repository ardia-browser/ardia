// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_H_

#include <cstdint>
#include <memory>
#include <optional>
#include <string>

#include "ardia/core/ac_content_hooks.h"
#include "base/files/file_path.h"
#include "base/values.h"

namespace content {
class DevToolsAgentHost;
class DevToolsAgentHostClient;
class RenderFrameHost;
class WebContents;
}

namespace ardia {

enum class TokenKind { kCli, kPlugin };

struct PluginScope {
  std::string credential_id;
  int window = 0;
  base::FilePath profile;
  bool off_the_record = false;
};

std::unique_ptr<ArdiaDevToolsTokenClient> CreateTokenClient(
    content::DevToolsAgentHostClient* client,
    content::DevToolsAgentHost* host,
    TokenKind kind,
    std::optional<PluginScope> scope);

std::optional<TokenKind> TokenClientKind(
    content::DevToolsAgentHostClient* root_client);

bool IsTokenClient(content::DevToolsAgentHostClient* root_client);

bool TokenClientMayAttach(content::DevToolsAgentHostClient* root_client,
                          content::DevToolsAgentHost* host);

bool TokenClientMayInput(content::DevToolsAgentHostClient* root_client,
                         content::RenderFrameHost* frame);

ArdiaSessionInput TokenClientSessionMayInput(
    content::DevToolsAgentHostClient* root_client,
    const std::string& session,
    int64_t grant,
    bool delivering);

int64_t TokenClientInputGrant(content::DevToolsAgentHostClient* root_client,
                              const std::string& session);

void InstallTokenClientInputHooks();

bool TokenClientRendererUntrusted(content::DevToolsAgentHostClient* root_client);

bool PluginMayConnectTo(const PluginScope& scope,
                        content::DevToolsAgentHost* host);

void CloseTokenClientsOf(const std::string& credential_id);

std::optional<std::string> PluginCredentialOf(
    content::DevToolsAgentHostClient* root_client);

bool PluginTabInScope(const std::string& credential_id,
                      content::WebContents* contents);

base::DictValue TokenCommandsByDomain();

struct PluginTotals {
  int minted = 0;
  int revoked = 0;
  int refused = 0;
  int holds = 0;
  int busy = 0;
};

PluginTotals& PluginTotalsSoFar();

}

#endif
