// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TOKEN_POLICY_INTERNAL_H_

#include <cstddef>
#include <map>
#include <string>
#include <string_view>
#include <utility>

#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/types/expected.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"

class GURL;

namespace content {
class DevToolsAgentHost;
class DevToolsAgentHostClient;
class RenderFrameHost;
}

namespace ardia {
namespace cli_token_policy_internal {

inline constexpr int kInvalidRequest = -32600;
inline constexpr int kInvalidParams = -32602;
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
  TokenClient(content::DevToolsAgentHostClient* client,
              content::DevToolsAgentHost* host);
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
  bool StartPageSignal(int id,
                       const std::string& session,
                       const std::string& method,
                       const base::DictValue* params,
                       std::string* reply);
  void PageSignalAnswered(int id,
                          const std::string& session,
                          base::expected<base::DictValue, std::string> outcome);

  const raw_ptr<content::DevToolsAgentHostClient> client_;
  const scoped_refptr<content::DevToolsAgentHost> host_;
  std::map<std::string, std::string> targets_;
  std::map<std::string, std::string> parents_;
  std::map<std::pair<std::string, int>, std::string> outstanding_;
  std::map<std::pair<std::string, int>, base::ScopedClosureRunner> running_;
  bool wedged_ = false;
  base::WeakPtrFactory<TokenClient> weak_factory_{this};
};

}
}

#endif
