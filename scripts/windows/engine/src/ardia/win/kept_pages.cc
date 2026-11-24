#include "ardia/win/kept_pages.h"

#include "ardia/win/host.h"
#include "ardia/win/page_links.h"
#include "ardia/win/tab_calls.h"
#include "base/functional/function_ref.h"
#include "base/memory/scoped_refptr.h"
#include "chrome/browser/devtools/devtools_window.h"
#include "components/performance_manager/public/graph/frame_node.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "content/public/browser/ardia_live_connection.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "third_party/blink/public/mojom/frame/sudden_termination_disabler_type.mojom.h"

namespace ardia_win {

namespace {

using performance_manager::FrameNode;
using performance_manager::PageNode;

void VisitFrames(const FrameNode* frame,
                 base::FunctionRef<void(const FrameNode*)> visit) {
  visit(frame);
  for (const FrameNode* child : frame->GetChildFrameNodes()) {
    VisitFrames(child, visit);
  }
}

bool InspectedByAnotherClient(content::WebContents* contents) {
  if (DevToolsWindow::GetInstanceForInspectedWebContents(contents)) {
    return true;
  }
  std::vector<const content::DevToolsAgentHostClient*> ours;
  if (const PageLinks* links = PageLinks::FromWebContents(contents)) {
    ours.push_back(links);
  }
  if (const content::DevToolsAgentHostClient* caller =
          EngineDevToolsClient(contents)) {
    ours.push_back(caller);
  }
  if (content::DevToolsAgentHost::HasFor(contents)) {
    scoped_refptr<content::DevToolsAgentHost> page =
        content::DevToolsAgentHost::GetOrCreateFor(contents);
    if (page && content::ArdiaHasOtherDevToolsClient(page.get(), ours)) {
      return true;
    }
  }
  scoped_refptr<content::DevToolsAgentHost> tab =
      content::DevToolsAgentHost::GetOrCreateForTab(contents);
  return tab && content::ArdiaHasOtherDevToolsClient(tab.get(), ours);
}

bool HasBeforeUnloadHandler(content::WebContents* contents) {
  bool handler = false;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&handler](content::RenderFrameHost* frame) {
        handler = handler ||
                  frame->GetSuddenTerminationDisablerState(
                      blink::mojom::SuddenTerminationDisablerType::
                          kBeforeUnloadHandler);
      });
  return handler;
}

bool HasLiveConnection(const PageNode* page, content::WebContents* contents) {
  bool live = page->UsesWebRTC();
  if (contents) {
    contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
        [&live](content::RenderFrameHost* frame) {
          live = live || content::ArdiaFrameHasLiveConnection(frame);
        });
  }
  return live;
}

bool KeepsPage(const PageNode* page) {
  return !KeptBy(page).empty();
}

}

std::vector<int> KeptBy(const PageNode* page) {
  std::vector<int> codes;
  if (!page) {
    return codes;
  }
  bool used = false;
  bool web_lock = false;
  bool indexed_db_lock = false;
  for (const FrameNode* main : page->GetMainFrameNodes()) {
    VisitFrames(main, [&](const FrameNode* frame) {
      used = used || frame->HadUserActivation();
      web_lock = web_lock || frame->IsHoldingWebLock();
      indexed_db_lock =
          indexed_db_lock || frame->IsHoldingBlockingIndexedDBLock();
    });
  }
  base::WeakPtr<content::WebContents> contents = page->GetWebContents();
  if (contents && Host::Get()->OpensLivePage(contents.get())) {
    codes.push_back(kOpensLivePage);
  }
  if (used && contents && HasBeforeUnloadHandler(contents.get())) {
    codes.push_back(kUnsavedAfterUse);
  }
  if (web_lock) {
    codes.push_back(kHoldsWebLock);
  }
  if (indexed_db_lock) {
    codes.push_back(kHoldsBlockingIndexedDBLock);
  }
  if (HasLiveConnection(page, contents.get())) {
    codes.push_back(kLiveConnection);
  }
  if (contents && InspectedByAnotherClient(contents.get())) {
    codes.push_back(kInspectedByAnotherClient);
  }
  return codes;
}

void AskBeforeDiscards() {
  performance_manager::policies::g_ardia_keeps_page = &KeepsPage;
}

}
