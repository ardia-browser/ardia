#include "ardia/core/ac_discard_veto.h"

#include <algorithm>
#include <utility>

#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "components/download/public/common/download_item.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/document_user_data.h"
#include "content/public/browser/download_item_utils.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"
#include "third_party/blink/public/mojom/frame/sudden_termination_disabler_type.mojom-shared.h"

namespace performance_manager::policies {
extern bool (*g_ardia_keeps_page)(const PageNode* page_node);
}

namespace ardiacore {

namespace {

bool g_bypassed = false;

class PostedDocument : public content::DocumentUserData<PostedDocument> {
 private:
  explicit PostedDocument(content::RenderFrameHost* frame)
      : content::DocumentUserData<PostedDocument>(frame) {}
  friend class content::DocumentUserData<PostedDocument>;
  DOCUMENT_USER_DATA_KEY_DECL();
};

DOCUMENT_USER_DATA_KEY_IMPL(PostedDocument);

class CliHeldTab : public content::WebContentsUserData<CliHeldTab> {
 public:
  base::TimeTicks until;
  bool vetoed = false;

 private:
  explicit CliHeldTab(content::WebContents* contents)
      : content::WebContentsUserData<CliHeldTab>(*contents) {}
  friend class content::WebContentsUserData<CliHeldTab>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(CliHeldTab);

std::vector<base::WeakPtr<content::WebContents>>& HeldTabs() {
  static base::NoDestructor<std::vector<base::WeakPtr<content::WebContents>>>
      held;
  return *held;
}

int g_cli_hold_vetoes = 0;

constexpr base::TimeDelta kLongestCliHold = base::Seconds(300);

CliHeldTab* HeldNow(content::WebContents* contents) {
  CliHeldTab* held = CliHeldTab::FromWebContents(contents);
  return held && base::TimeTicks::Now() < held->until ? held : nullptr;
}

bool RunsDownload(content::WebContents* contents) {
  content::DownloadManager* manager =
      contents->GetBrowserContext()->GetDownloadManager();
  if (!manager) {
    return false;
  }
  content::DownloadManager::DownloadVector items;
  manager->GetAllDownloads(&items);
  for (download::DownloadItem* item : items) {
    if (item->GetState() == download::DownloadItem::IN_PROGRESS &&
        content::DownloadItemUtils::GetOriginalWebContents(item) == contents) {
      return true;
    }
  }
  return false;
}

bool HasBeforeUnloadHandler(content::WebContents* contents) {
  bool found = false;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&found](content::RenderFrameHost* frame) {
        found = found ||
                (frame->IsRenderFrameLive() &&
                 frame->GetSuddenTerminationDisablerState(
                     blink::mojom::SuddenTerminationDisablerType::
                         kBeforeUnloadHandler));
      });
  return found;
}

bool PageVetoed(const performance_manager::PageNode* page) {
  if (g_bypassed) {
    return false;
  }
  base::WeakPtr<content::WebContents> contents = page->GetWebContents();
  if (!contents) {
    return false;
  }
  if (CliHeldTab* held = HeldNow(contents.get()); held && !held->vetoed) {
    held->vetoed = true;
    ++g_cli_hold_vetoes;
  }
  return !DiscardVetoesFor(contents.get()).empty();
}

}

std::vector<DiscardVeto> DiscardVetoesFor(content::WebContents* contents) {
  std::vector<DiscardVeto> vetoes;
  if (!contents) {
    return vetoes;
  }
  if (PostedDocument::GetForCurrentDocument(contents->GetPrimaryMainFrame())) {
    vetoes.push_back(DiscardVeto::kPostedDocument);
  }
  if (HasBeforeUnloadHandler(contents)) {
    vetoes.push_back(DiscardVeto::kBeforeUnload);
  }
  if (RunsDownload(contents)) {
    vetoes.push_back(DiscardVeto::kDownload);
  }
  if (HeldNow(contents)) {
    vetoes.push_back(DiscardVeto::kCliHold);
  }
  return vetoes;
}

std::vector<bool> SetCliHeldTabs(
    const std::vector<std::pair<content::WebContents*, base::Time>>& held) {
  const base::TimeTicks now = base::TimeTicks::Now();
  const base::Time wall_now = base::Time::Now();
  std::vector<std::pair<content::WebContents*, base::TimeDelta>> live;
  std::vector<bool> placed(held.size(), false);
  for (size_t i = 0; i < held.size(); ++i) {
    const base::TimeDelta lasts =
        std::min(held[i].second - wall_now, kLongestCliHold);
    if (held[i].first && lasts.is_positive()) {
      live.emplace_back(held[i].first, lasts);
      placed[i] = true;
    }
  }
  std::vector<base::WeakPtr<content::WebContents>>& marked = HeldTabs();
  for (const base::WeakPtr<content::WebContents>& contents : marked) {
    if (contents &&
        std::ranges::find(
            live, contents.get(),
            &std::pair<content::WebContents*, base::TimeDelta>::first) ==
            live.end()) {
      contents->RemoveUserData(CliHeldTab::UserDataKey());
    }
  }
  marked.clear();
  for (const auto& [contents, lasts] : live) {
    CliHeldTab* mark = CliHeldTab::FromWebContents(contents);
    if (!mark || mark->until <= now) {
      contents->RemoveUserData(CliHeldTab::UserDataKey());
      CliHeldTab::CreateForWebContents(contents);
      mark = CliHeldTab::FromWebContents(contents);
    }
    mark->until = now + lasts;
    marked.push_back(contents->GetWeakPtr());
  }
  return placed;
}

int TakeCliHoldVetoes() {
  return std::exchange(g_cli_hold_vetoes, 0);
}

void NotePostedDocument(content::NavigationHandle* handle) {
  if (!handle->IsInPrimaryMainFrame() || !handle->HasCommitted() ||
      handle->IsSameDocument() || handle->IsServedFromBackForwardCache() ||
      !handle->IsPost()) {
    return;
  }
  PostedDocument::GetOrCreateForCurrentDocument(handle->GetRenderFrameHost());
}

void InstallDiscardVeto() {
  performance_manager::policies::g_ardia_keeps_page = &PageVetoed;
}

ScopedDiscardVetoBypass::ScopedDiscardVetoBypass() : was_bypassed_(g_bypassed) {
  g_bypassed = true;
}

ScopedDiscardVetoBypass::~ScopedDiscardVetoBypass() {
  g_bypassed = was_bypassed_;
}

}
