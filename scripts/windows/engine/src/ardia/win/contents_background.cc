#include "ardia/win/contents_background.h"

#include <string>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/win/page_links.h"
#include "base/functional/bind.h"
#include "base/memory/scoped_refptr.h"
#include "base/strings/string_number_conversions.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/global_browser_collection.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/contents_web_view.h"
#include "chrome/browser/ui/views/frame/multi_contents_view.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_view_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"

extern std::optional<SkColor> (*g_ardia_win_contents_background)(
    content::WebContents* contents);

namespace ardia_win {

namespace {

enum class AheadBlank { kNone, kLoading, kShown, kEnded };

bool IsEngineClient(content::WebContents& contents,
                    const content::DevToolsAgentHostClient* client) {
  const PageLinks* links = PageLinks::FromWebContents(&contents);
  return links && client == links;
}

bool OtherClientAttached(content::WebContents& contents) {
  if (!content::DevToolsAgentHost::HasFor(&contents)) {
    return false;
  }
  scoped_refptr<content::DevToolsAgentHost> page =
      content::DevToolsAgentHost::GetOrCreateFor(&contents);
  std::vector<const content::DevToolsAgentHostClient*> ours;
  if (const PageLinks* links = PageLinks::FromWebContents(&contents)) {
    ours.push_back(links);
  }
  return page && content::ArdiaHasOtherDevToolsClient(page.get(), ours);
}

void RefreshIfShowing(content::WebContents* contents,
                      ContentsWebView* web_view) {
  if (web_view && web_view->web_contents() == contents) {
    web_view->SetBackgroundVisible(true);
  }
}

void RefreshContentsWebView(content::WebContents* contents) {
  BrowserWindowInterface* browser =
      GlobalBrowserCollection::GetInstance()->FindBrowserWithTab(contents);
  BrowserView* view =
      browser ? BrowserView::GetBrowserViewForBrowser(browser) : nullptr;
  MultiContentsView* multi = view ? view->multi_contents_view() : nullptr;
  if (multi) {
    multi->ExecuteOnEachVisibleContentsView(
        base::BindRepeating(&RefreshIfShowing, base::Unretained(contents)));
  }
}

class ContentsBackground
    : public content::WebContentsObserver,
      public content::WebContentsUserData<ContentsBackground> {
 public:
  void SetColor(SkColor color) {
    color_ = SkColorSetA(color, SK_AlphaOPAQUE);
    ApplyView();
    RefreshContentsWebView(&GetWebContents());
    ApplyPageBase();
  }

  void MarkAheadBlank() {
    if (ahead_blank_ != AheadBlank::kNone) {
      return;
    }
    content::NavigationController& controller =
        GetWebContents().GetController();
    content::NavigationEntry* committed = controller.GetLastCommittedEntry();
    if (GetWebContents().HasOpener() || OtherClientAttached(GetWebContents())) {
      ahead_blank_ = AheadBlank::kEnded;
    } else if (!committed || committed->IsInitialEntry()) {
      ahead_blank_ = AheadBlank::kLoading;
    } else if (controller.GetEntryCount() == 1 &&
               committed->GetURL().IsAboutBlank()) {
      ahead_blank_ = AheadBlank::kShown;
    } else {
      ahead_blank_ = AheadBlank::kEnded;
    }
    ApplyView();
    ApplyPageBase();
  }

  void EndAheadBlank() {
    if (ahead_blank_ == AheadBlank::kEnded) {
      return;
    }
    ahead_blank_ = AheadBlank::kEnded;
    ApplyView();
    ApplyPageBase();
  }

  void SessionAttached(const content::DevToolsAgentHostClient* client) {
    if (!IsEngineClient(GetWebContents(), client)) {
      EndAheadBlank();
    }
  }

  std::optional<SkColor> color() const { return color_; }

 private:
  explicit ContentsBackground(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<ContentsBackground>(*contents) {}
  friend class content::WebContentsUserData<ContentsBackground>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();

  bool AheadBlankShowsColor() const {
    return color_ && (ahead_blank_ == AheadBlank::kLoading ||
                      ahead_blank_ == AheadBlank::kShown);
  }

  void ApplyView() {
    content::RenderWidgetHostView* view =
        GetWebContents().GetRenderWidgetHostView();
    if (view && color_) {
      view->SetBackgroundColor(AheadBlankShowsColor() ? SK_ColorTRANSPARENT
                                                      : *color_);
    }
  }

  void ApplyPageBase() {
    std::optional<SkColor> base =
        AheadBlankShowsColor() ? std::optional<SkColor>(SK_ColorTRANSPARENT)
                               : std::nullopt;
    if (base == applied_page_base_) {
      return;
    }
    applied_page_base_ = base;
    GetWebContents().SetPageBaseBackgroundColor(base);
  }

  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override {
    if (new_host && new_host == GetWebContents().GetPrimaryMainFrame()) {
      ApplyView();
    }
  }

  void RenderViewHostChanged(content::RenderViewHost* old_host,
                             content::RenderViewHost* new_host) override {
    ApplyView();
  }

  void RenderViewReady() override { ApplyView(); }

  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame() && navigation->IsSameDocument()) {
      EndAheadBlank();
    }
    if (navigation->IsInPrerenderedMainFrame() &&
        applied_page_base_ == SK_ColorTRANSPARENT) {
      prerender_saw_color_ = true;
      EndAheadBlank();
    }
  }

  void ReadyToCommitNavigation(content::NavigationHandle* navigation) override {
    if (!navigation->IsInPrimaryMainFrame() || navigation->IsSameDocument()) {
      return;
    }
    if (ahead_blank_ == AheadBlank::kLoading &&
        navigation->GetURL().IsAboutBlank()) {
      ahead_blank_ = AheadBlank::kShown;
      return;
    }
    EndAheadBlank();
  }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (!prerender_saw_color_ || !navigation->IsPrerenderedPageActivation() ||
        !navigation->HasCommitted()) {
      return;
    }
    prerender_saw_color_ = false;
    GetWebContents().SetPageBaseBackgroundColor(SK_ColorWHITE);
    applied_page_base_ = SK_ColorWHITE;
    ApplyPageBase();
  }

  std::optional<SkColor> color_;
  std::optional<SkColor> applied_page_base_;
  AheadBlank ahead_blank_ = AheadBlank::kNone;
  bool prerender_saw_color_ = false;
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ContentsBackground);

ContentsBackground* For(content::WebContents* contents) {
  ContentsBackground::CreateForWebContents(contents);
  return ContentsBackground::FromWebContents(contents);
}

std::optional<SkColor> ColorFor(content::WebContents* contents) {
  ContentsBackground* background =
      contents ? ContentsBackground::FromWebContents(contents) : nullptr;
  return background ? background->color() : std::nullopt;
}

void (*g_previous_initial_document_accessed)(content::WebContents*) = nullptr;

void InitialDocumentAccessed(content::WebContents* contents) {
  EndAheadBlank(contents);
  if (g_previous_initial_document_accessed) {
    g_previous_initial_document_accessed(contents);
  }
}

void (*g_previous_session_attached)(content::DevToolsAgentHostClient*,
                                    content::DevToolsAgentHost*,
                                    const void*) = nullptr;

void SessionAttached(content::DevToolsAgentHostClient* root_client,
                     content::DevToolsAgentHost* host,
                     const void* session) {
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  if (ContentsBackground* background =
          contents ? ContentsBackground::FromWebContents(contents) : nullptr) {
    background->SessionAttached(root_client);
  }
  if (g_previous_session_attached) {
    g_previous_session_attached(root_client, host, session);
  }
}

bool IsCardHex(const std::string& text) {
  if (text.size() != 7 || text[0] != '#') {
    return false;
  }
  for (size_t i = 1; i < text.size(); ++i) {
    const char c = text[i];
    if (!((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F'))) {
      return false;
    }
  }
  return true;
}

}

ContentsBackgroundArgument ReadContentsBackground(const base::DictValue& args) {
  ContentsBackgroundArgument argument;
  const base::Value* value = args.Find("contentsBackground");
  if (!value) {
    return argument;
  }
  if (!value->is_string()) {
    argument.given = true;
    argument.malformed = true;
    return argument;
  }
  const std::string& text = value->GetString();
  if (text.empty()) {
    return argument;
  }
  argument.given = true;
  uint32_t rgb = 0;
  if (!IsCardHex(text) || !base::HexStringToUInt(text.substr(1), &rgb)) {
    argument.malformed = true;
    return argument;
  }
  argument.color = SkColorSetRGB((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF,
                                 rgb & 0xFF);
  return argument;
}

void SetContentsBackground(content::WebContents* contents, SkColor color) {
  For(contents)->SetColor(color);
}

void RefreshContentsBackground(content::WebContents* contents) {
  RefreshContentsWebView(contents);
}

void MarkAheadBlank(content::WebContents* contents) {
  For(contents)->MarkAheadBlank();
}

void EndAheadBlank(content::WebContents* contents) {
  if (ContentsBackground* background =
          contents ? ContentsBackground::FromWebContents(contents) : nullptr) {
    background->EndAheadBlank();
  }
}

void InstallContentsBackground() {
  if (g_ardia_win_contents_background == &ColorFor) {
    return;
  }
  g_ardia_win_contents_background = &ColorFor;
  g_previous_initial_document_accessed = g_ardia_initial_main_document_accessed;
  g_ardia_initial_main_document_accessed = &InitialDocumentAccessed;
  g_previous_session_attached = g_ardia_devtools_session_attached;
  g_ardia_devtools_session_attached = &SessionAttached;
}

}
