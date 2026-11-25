#include "ardia/core/ac_discard_veto.h"

#include <algorithm>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
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
#include "ui/gfx/geometry/size.h"

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

constexpr bool kLiveStaysHidden = false;
constexpr bool kLiveStaysAwake = false;
constexpr bool kLiveIsActivity = false;

class CliHeldTab : public content::WebContentsUserData<CliHeldTab> {
 public:
  base::TimeTicks until;
  bool vetoed = false;

  void KeepLive(bool live, base::TimeDelta lasts) {
    if (!live) {
      EndLive();
      return;
    }
    if (!capture_) {
      capture_ = GetWebContents().IncrementCapturerCount(
          gfx::Size(), kLiveStaysHidden, kLiveStaysAwake, kLiveIsActivity);
    }
    expiry_.Start(FROM_HERE, lasts,
                  base::BindOnce(&CliHeldTab::EndLive, base::Unretained(this)));
  }

 private:
  explicit CliHeldTab(content::WebContents* contents)
      : content::WebContentsUserData<CliHeldTab>(*contents) {}

  void EndLive() {
    expiry_.Stop();
    if (capture_) {
      capture_.RunAndReset();
    }
  }

  base::ScopedClosureRunner capture_;
  base::OneShotTimer expiry_;
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

std::vector<bool> SetCliHeldTabs(const std::vector<CliHold>& held) {
  struct Kept {
    content::WebContents* contents;
    base::TimeDelta lasts;
    bool live;
  };
  const base::TimeTicks now = base::TimeTicks::Now();
  const base::Time wall_now = base::Time::Now();
  std::vector<Kept> kept;
  std::vector<bool> placed(held.size(), false);
  for (size_t i = 0; i < held.size(); ++i) {
    const base::TimeDelta lasts =
        std::min(held[i].until - wall_now, kLongestCliHold);
    if (held[i].contents && !held[i].contents->IsBeingDestroyed() &&
        lasts.is_positive()) {
      kept.push_back({held[i].contents, lasts, held[i].live});
      placed[i] = true;
    }
  }
  std::vector<base::WeakPtr<content::WebContents>>& marked = HeldTabs();
  for (const base::WeakPtr<content::WebContents>& contents : marked) {
    if (contents && std::ranges::find(kept, contents.get(), &Kept::contents) ==
                        kept.end()) {
      contents->RemoveUserData(CliHeldTab::UserDataKey());
    }
  }
  marked.clear();
  for (const Kept& hold : kept) {
    CliHeldTab* mark = CliHeldTab::FromWebContents(hold.contents);
    if (!mark || mark->until <= now) {
      hold.contents->RemoveUserData(CliHeldTab::UserDataKey());
      CliHeldTab::CreateForWebContents(hold.contents);
      mark = CliHeldTab::FromWebContents(hold.contents);
    }
    mark->until = now + hold.lasts;
    mark->KeepLive(hold.live, hold.lasts);
    marked.push_back(hold.contents->GetWeakPtr());
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
