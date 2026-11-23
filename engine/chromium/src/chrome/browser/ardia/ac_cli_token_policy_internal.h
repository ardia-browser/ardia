// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_

#include <cstddef>
#include <map>
#include <string>
#include <string_view>
#include <utility>

#include "base/memory/raw_ptr.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"

class GURL;

namespace content {
class DevToolsAgentHostClient;
class RenderFrameHost;
}

namespace ardia {
namespace cli_token_policy_internal {

inline constexpr int kInvalidRequest = -32600;
inline constexpr int kParseError = -32700;
inline constexpr int kRefused = -32000;
inline constexpr size_t kMaxPending = 4096;

bool NeedsResponse(std::string_view method);
bool IsOffscreenTarget(const std::string* target_id);
void CountCommand(std::string_view method);

std::string ErrorReply(int id,
                       const std::string& session,
                       int code,
                       const std::string& message);

class TokenClient;

std::map<content::DevToolsAgentHostClient*, TokenClient*>& Registry();

class TokenClient : public ArdiaDevToolsTokenClient {
 public:
  explicit TokenClient(content::DevToolsAgentHostClient* client);
  ~TokenClient() override;

  bool FilterCommand(std::string& message, std::string* reply) override;
  bool FilterEvent(std::string& message) override;
  bool ShouldClose() const override;
  bool MayAttachToURL(const GURL& url, bool is_webui) override;
  bool MayAttachToRenderFrameHost(content::RenderFrameHost* frame) override;

 private:
  void ForgetSession(const std::string& session);
  void ForgetSessionTree(const std::string& session);
  void NoteTargetEvent(std::string_view method, const std::string& message);
  bool FilterResponse(int id, const std::string& method, std::string& message);

  const raw_ptr<content::DevToolsAgentHostClient> client_;
  std::map<std::string, std::string> targets_;
  std::map<std::string, std::string> parents_;
  std::map<std::pair<std::string, int>, std::string> outstanding_;
  bool wedged_ = false;
};

}
}

#endif
