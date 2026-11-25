// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_PAGE_READER_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_PAGE_READER_H_

#include <map>
#include <set>
#include <string>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/types/expected.h"
#include "chrome/browser/ardia/ac_cli_cdp.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/gfx/geometry/size_f.h"

namespace content {
class NavigationHandle;
class WebContents;
}

namespace ardia {

inline constexpr size_t kMaxPageFrames = 24;

class PageReader : public content::WebContentsObserver {
 public:
  using Done = base::OnceCallback<void(base::expected<PageModel, std::string>)>;

  PageReader(content::WebContents* contents,
             CdpSession* probe,
             const std::map<std::string, std::string>* children,
             double scale);
  PageReader(const PageReader&) = delete;
  PageReader& operator=(const PageReader&) = delete;
  ~PageReader() override;

  void Read(Done done);

  void DidFinishNavigation(content::NavigationHandle* navigation) override;

 private:
  struct Planned {
    std::string token;
    int parent = -1;
    std::string local_root;
    std::string session;
    bool reachable = false;
  };

  bool Plan();
  void WaitForSessions();
  void ReadMetrics();
  void GotMetrics(CdpResult result);
  void Step();
  void GotSnapshot(std::string session, CdpResult result);
  void GotTree(size_t frame, CdpResult result);
  void GotFrameOwner(size_t frame, CdpResult result);
  void GotOwner(int owner, std::string session, CdpResult result);
  void Finish();
  void Fail(const std::string& why);

  raw_ptr<content::WebContents> contents_;
  raw_ptr<CdpSession> probe_;
  raw_ptr<const std::map<std::string, std::string>> children_;
  double scale_;
  Done done_;
  std::vector<Planned> planned_;
  bool truncated_ = false;
  std::vector<FrameRead> frames_;
  std::map<std::string, DocRead> docs_;
  std::map<std::string, std::vector<int>> owners_by_session_;
  std::set<std::string> planned_tokens_;
  std::set<std::string> stale_tokens_;
  gfx::SizeF viewport_;
  int waiting_ = 0;
  int phase_ = 0;
  int session_polls_ = 0;
  base::OneShotTimer poll_;
  base::WeakPtrFactory<PageReader> weak_factory_{this};
};

}

#endif
