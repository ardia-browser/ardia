// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_PAGE_CHANNEL_PAGE_CHANNEL_H_
#define ARDIA_LINUX_PAGE_CHANNEL_PAGE_CHANNEL_H_

#include <map>
#include <optional>
#include <string>

#include "ardia/core/mojom/ardiacore.mojom.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/render_frame_host_receiver_set.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"

namespace blink {
class AssociatedInterfaceRegistry;
}

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace ardia_linux {

class DomainVerbs;

void RegisterPageChannelBinders(content::RenderFrameHost& render_frame_host,
                                blink::AssociatedInterfaceRegistry& registry);

void StartPageScript();

void AmendTabEvent(base::DictValue& event);

void ResetPageReports(content::WebContents* contents, bool gone);

void AddPageChannelVerbs(DomainVerbs& verbs);

class PageChannel : public content::WebContentsObserver,
                    public content::WebContentsUserData<PageChannel>,
                    public ardiacore::mojom::ACPageHost {
 public:
  ~PageChannel() override;

  static PageChannel* GetOrCreate(content::WebContents* contents);
  static std::string FrameId(content::RenderFrameHost* frame);

  void Bind(content::RenderFrameHost* frame,
            mojo::PendingAssociatedReceiver<ardiacore::mojom::ACPageHost>
                receiver);

  void CallPage(const std::string& kind, const std::string& json);
  void CallFrame(const std::string& frame_id,
                 const std::string& kind,
                 const std::string& json);
  void Execute(const std::string& code);
  void Evaluate(
      const std::string& code,
      base::OnceCallback<void(const std::optional<std::string>&)> callback);

  void Post(const std::string& kind, const std::string& json) override;

  void PrimaryPageChanged(content::Page& page) override;
  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override;
  void WebContentsDestroyed() override;

 private:
  friend class content::WebContentsUserData<PageChannel>;
  explicit PageChannel(content::WebContents* contents);

  ardiacore::mojom::ACPage* MainPage();
  content::RenderFrameHost* FindFrame(const std::string& frame_id);

  content::RenderFrameHostReceiverSet<ardiacore::mojom::ACPageHost>
      receivers_;
  mojo::AssociatedRemote<ardiacore::mojom::ACPage> main_page_;
  content::GlobalRenderFrameHostId main_page_frame_;
  base::WeakPtrFactory<PageChannel> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

void HandlePageMessage(content::WebContents* contents,
                       content::RenderFrameHost& frame,
                       const std::string& kind,
                       const std::string& json);

bool CallPageChannelMethod(content::WebContents* contents,
                           const std::string& method,
                           const base::DictValue& args);

}

#endif
