#ifndef ARDIA_WIN_PAGE_LINKS_H_
#define ARDIA_WIN_PAGE_LINKS_H_

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/values.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/gfx/geometry/point_f.h"
#include "url/gurl.h"

namespace content {
class RenderFrameHost;
}

namespace ui {
class MouseEvent;
}

namespace ardia_win {

class PageLinks : public content::WebContentsUserData<PageLinks>,
                  public content::DevToolsAgentHostClient {
 public:
  PageLinks(const PageLinks&) = delete;
  PageLinks& operator=(const PageLinks&) = delete;
  ~PageLinks() override;

  static void Watch(content::WebContents* contents);
  static void Configure(const base::DictValue& args);
  static base::DictValue Config();
  static void NoteMouse(const ui::MouseEvent& event, const std::string& page);
  static std::optional<gfx::PointF> RecentClickPoint(const std::string& page);

  void FrameCommitted(content::RenderFrameHost* frame, bool restored);
  void ReattachForTest();
  void RendererReady();
  bool TakeNewTabLink(const std::vector<GURL>& urls);
  int ScriptFrames() const { return static_cast<int>(contexts_.size()); }
  base::ListValue ReportsForTest() const;

  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override;
  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override;
  bool MayAttachToURL(const GURL& url, bool is_webui) override;
  bool IsTrusted() override;
  bool MayReadLocalFiles() override;

 private:
  friend class content::WebContentsUserData<PageLinks>;
  using Answer = base::OnceCallback<void(std::optional<base::DictValue>)>;
  struct Context {
    std::string frame_token;
  };
  struct NewTabLink {
    GURL url;
    base::TimeTicks at;
  };

  explicit PageLinks(content::WebContents* contents);

  bool Attach();
  void Note(std::string_view what, bool failed = false);
  void ResetSession();
  void Recover();
  void RecoverNow(int session);
  void ScheduleReattach();
  void Reattach();
  void Register();
  std::string Tag();
  void RuntimeEnabled(std::optional<base::DictValue> answer);
  void AddScript(bool run_now);
  void SendConfig(int context);
  void NoteReportForTest(const std::string& kind,
                         const std::string& url,
                         const std::string& outcome);
  void ScriptAdded(std::optional<base::DictValue> added);
  std::string SourceForNewDocuments();
  void ContextCreated(const base::DictValue& params);
  content::RenderFrameHost* ActiveFrameWithToken(const std::string& token);
  void Call(const std::string& method, base::DictValue params, Answer answer);
  void Evaluate(int context, const std::string& expression);
  void PushConfig();
  std::string ConfigJson();
  std::string PageKey();
  bool PeeksOtherSites();
  void Heard(int context, const std::string& payload);
  void PeekLink(const base::DictValue& data, int context, bool main);
  void NoteNewTabLink(const base::DictValue& data);
  void DropStaleNewTabLinks();
  void FallBack(const base::DictValue& data,
                const GURL& url,
                int context,
                const std::string& reason);
  void Refuse(int context, base::DictValue refusal);
  void OpenWindow(base::DictValue payload);
  gfx::PointF ClampedToPage(gfx::PointF point);

  scoped_refptr<content::DevToolsAgentHost> host_;
  int next_id_ = 1;
  std::map<int, Answer> pending_;
  std::map<int, Context> contexts_;
  std::optional<std::string> script_id_;
  std::optional<std::string> replacing_;
  int registered_config_ = 0;
  bool enabling_ = false;
  bool registering_ = false;
  int session_ = 0;
  bool recovering_ = false;
  bool reattach_spent_ = false;
  std::vector<NewTabLink> new_tab_links_;
  std::vector<base::DictValue> reports_for_test_;
  int report_seq_ = 0;
  base::WeakPtrFactory<PageLinks> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

class OpenRequest : public content::WebContentsObserver,
                    public content::WebContentsUserData<OpenRequest> {
 public:
  OpenRequest(const OpenRequest&) = delete;
  OpenRequest& operator=(const OpenRequest&) = delete;
  ~OpenRequest() override;

  static void Note(content::WebContents* opened);

  bool started() const { return started_; }
  bool clicked() const { return started_ && gesture_ && !form_; }
  const GURL& url() const { return url_; }

  void DidStartNavigation(content::NavigationHandle* handle) override;

 private:
  friend class content::WebContentsUserData<OpenRequest>;
  explicit OpenRequest(content::WebContents* contents);

  bool started_ = false;
  bool gesture_ = false;
  bool form_ = false;
  GURL url_;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}

#endif
