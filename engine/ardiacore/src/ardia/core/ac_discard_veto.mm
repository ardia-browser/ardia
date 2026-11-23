#include "ardia/core/ac_discard_veto.h"

#include "base/memory/weak_ptr.h"
#include "components/download/public/common/download_item.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/document_user_data.h"
#include "content/public/browser/download_item_utils.h"
#include "content/public/browser/download_manager.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
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
  return contents && !DiscardVetoesFor(contents.get()).empty();
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
  return vetoes;
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
