#include "ardia/win/autoplay.h"

#include <optional>
#include <set>
#include <string>
#include <vector>

#include "ardia/win/tab_state.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "chrome/browser/content_settings/host_content_settings_map_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "components/content_settings/core/browser/content_settings_observer.h"
#include "components/content_settings/core/browser/content_settings_type_set.h"
#include "components/content_settings/core/browser/host_content_settings_map.h"
#include "components/content_settings/core/common/content_settings.h"
#include "components/content_settings/core/common/content_settings_pattern.h"
#include "components/content_settings/core/common/content_settings_types.h"
#include "content/public/browser/disallow_activation_reason.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/page_user_data.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "third_party/blink/public/common/associated_interfaces/associated_interface_provider.h"
#include "third_party/blink/public/mojom/autoplay/autoplay.mojom.h"
#include "url/gurl.h"
#include "url/origin.h"

extern bool (*g_ardia_win_autoplay_blocked)(content::WebContents* contents,
                                            const url::Origin& top_level);
extern void (*g_ardia_win_autoplay_refused)(content::RenderFrameHost* frame);

namespace ardia_win {

namespace {

constexpr int kMostCountedPerPage = 20;
constexpr base::TimeDelta kCountDelay = base::Seconds(1);

bool g_block_everywhere = false;

HostContentSettingsMap* SettingsFor(content::WebContents* contents) {
  return contents ? HostContentSettingsMapFactory::GetForProfile(
                        Profile::FromBrowserContext(
                            contents->GetBrowserContext()))
                  : nullptr;
}

bool BlockedAt(content::WebContents* contents, const url::Origin& top_level) {
  const GURL url = top_level.GetTupleOrPrecursorTupleIfOpaque().GetURL();
  if (!url.SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  HostContentSettingsMap* settings = SettingsFor(contents);
  if (!settings) {
    return false;
  }
  content_settings::SettingInfo info;
  const ContentSetting value = settings->GetContentSetting(
      url, url, ContentSettingsType::AUTOPLAY, &info);
  return value == CONTENT_SETTING_BLOCK ||
         (g_block_everywhere && info.primary_pattern.MatchesAllHosts());
}

mojo::AssociatedRemote<blink::mojom::AutoplayConfigurationClient> ClientOf(
    content::RenderFrameHost* frame) {
  mojo::AssociatedRemote<blink::mojom::AutoplayConfigurationClient> client;
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&client);
  return client;
}

class AutoplayPage : public content::PageUserData<AutoplayPage> {
 public:
  int counted = 0;
  std::optional<bool> blocked;

 private:
  friend class content::PageUserData<AutoplayPage>;
  explicit AutoplayPage(content::Page& page)
      : content::PageUserData<AutoplayPage>(page) {}
  PAGE_USER_DATA_KEY_DECL();
};

PAGE_USER_DATA_KEY_IMPL(AutoplayPage);

bool InBackForwardCache(content::RenderFrameHost* frame) {
  return frame->IsInLifecycleState(
      content::RenderFrameHost::LifecycleState::kInBackForwardCache);
}

void Send(content::RenderFrameHost* frame, bool blocked) {
  if (frame && frame->IsRenderFrameLive()) {
    ClientOf(frame)->SetArdiaAutoplayBlocked(blocked);
  }
}

void Tell(content::WebContents* contents, content::RenderFrameHost* frame) {
  if (!frame || InBackForwardCache(frame)) {
    return;
  }
  const bool blocked = BlockedAt(
      contents, frame->GetOutermostMainFrame()->GetLastCommittedOrigin());
  AutoplayPage::GetOrCreateForPage(frame->GetPage())->blocked = blocked;
  Send(frame, blocked);
}

void EvictIfChanged(content::WebContents* contents,
                    content::RenderFrameHost* frame) {
  if (frame->GetParentOrOuterDocument()) {
    return;
  }
  const bool blocked = BlockedAt(contents, frame->GetLastCommittedOrigin());
  AutoplayPage* page = AutoplayPage::GetForPage(frame->GetPage());
  if (page && page->blocked.has_value() && *page->blocked != blocked) {
    frame->IsInactiveAndDisallowActivation(
        content::kMinEmbedderDisallowActivationReason);
  }
}

class AutoplayFollower : public content::WebContentsObserver,
                         public content::WebContentsUserData<AutoplayFollower>,
                         public content_settings::Observer {
 public:
  AutoplayFollower(const AutoplayFollower&) = delete;
  AutoplayFollower& operator=(const AutoplayFollower&) = delete;
  ~AutoplayFollower() override {
    Live().erase(this);
    StopObserving();
  }

  static std::set<AutoplayFollower*>& Live() {
    static base::NoDestructor<std::set<AutoplayFollower*>> live;
    return *live;
  }

  void TellEveryFrame() {
    content::WebContents* contents = web_contents();
    if (!contents) {
      return;
    }
    std::vector<content::RenderFrameHost*> cached;
    contents->ForEachRenderFrameHost(
        [contents, &cached](content::RenderFrameHost* frame) {
          if (InBackForwardCache(frame)) {
            cached.push_back(frame);
          } else {
            Tell(contents, frame);
          }
        });
    for (content::RenderFrameHost* frame : cached) {
      EvictIfChanged(contents, frame);
    }
    for (content::NavigationHandle* handle : committing_) {
      content::RenderFrameHost* outer = handle->GetParentFrameOrOuterDocument();
      Send(handle->GetRenderFrameHost(),
           BlockedAt(contents,
                     outer ? outer->GetOutermostMainFrame()->GetLastCommittedOrigin()
                           : handle->GetOriginToCommit().value_or(url::Origin())));
    }
  }

  void Refused(content::RenderFrameHost* frame) {
    if (!frame->GetPage().IsPrimary()) {
      return;
    }
    AutoplayPage* page = AutoplayPage::GetOrCreateForPage(frame->GetPage());
    if (page->counted >= kMostCountedPerPage) {
      return;
    }
    ++page->counted;
    if (unsent_++ == 0) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&AutoplayFollower::SendCount,
                         weak_factory_.GetWeakPtr()),
          kCountDelay);
    }
  }

 private:
  friend class content::WebContentsUserData<AutoplayFollower>;

  explicit AutoplayFollower(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<AutoplayFollower>(*contents),
        settings_(SettingsFor(contents)) {
    if (settings_) {
      settings_->AddObserver(this);
    }
    Live().insert(this);
    TellEveryFrame();
  }

  void ReadyToCommitNavigation(content::NavigationHandle* handle) override {
    if (!handle->IsSameDocument()) {
      committing_.insert(handle);
    }
  }

  void DidFinishNavigation(content::NavigationHandle* handle) override {
    committing_.erase(handle);
    if (!handle->HasCommitted() || handle->IsSameDocument()) {
      return;
    }
    content::WebContents* contents = web_contents();
    content::RenderFrameHost* frame = handle->GetRenderFrameHost();
    if (handle->IsServedFromBackForwardCache() ||
        handle->IsPrerenderedPageActivation()) {
      frame->ForEachRenderFrameHost(
          [contents](content::RenderFrameHost* each) { Tell(contents, each); });
      return;
    }
    Tell(contents, frame);
  }

  void PrimaryPageChanged(content::Page& page) override { SendCount(); }

  void SendCount() {
    if (!unsent_) {
      return;
    }
    const int count = unsent_;
    unsent_ = 0;
    if (TabState* state = TabState::FromWebContents(web_contents())) {
      base::DictValue data;
      data.Set("count", count);
      state->Send("autoplayBlocked", std::move(data));
    }
  }

  void OnContentSettingChanged(const ContentSettingsPattern& primary_pattern,
                               const ContentSettingsPattern& secondary_pattern,
                               ContentSettingsTypeSet types) override {
    if (types.Contains(ContentSettingsType::AUTOPLAY)) {
      TellEveryFrame();
    }
  }

  void WebContentsDestroyed() override { StopObserving(); }

  void StopObserving() {
    if (settings_) {
      settings_->RemoveObserver(this);
    }
    settings_ = nullptr;
  }

  raw_ptr<HostContentSettingsMap> settings_;
  std::set<raw_ptr<content::NavigationHandle>> committing_;
  int unsent_ = 0;
  base::WeakPtrFactory<AutoplayFollower> weak_factory_{this};
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(AutoplayFollower);

void NoteRefused(content::RenderFrameHost* frame) {
  content::WebContents* contents =
      content::WebContents::FromRenderFrameHost(frame);
  if (AutoplayFollower* follower =
          contents ? AutoplayFollower::FromWebContents(contents) : nullptr) {
    follower->Refused(frame);
  }
}

}

void InstallAutoplayPolicy() {
  g_ardia_win_autoplay_blocked = [](content::WebContents* contents,
                                    const url::Origin& top_level) {
    return contents && BlockedAt(contents, top_level);
  };
  g_ardia_win_autoplay_refused = &NoteRefused;
}

void WatchAutoplay(content::WebContents* contents) {
  if (contents && !AutoplayFollower::FromWebContents(contents)) {
    AutoplayFollower::CreateForWebContents(contents);
  }
}

base::DictValue SetBlockAutoplayEverywhere(const base::DictValue& args) {
  const bool enabled = args.FindBool("enabled").value_or(false);
  if (enabled != g_block_everywhere) {
    g_block_everywhere = enabled;
    for (AutoplayFollower* follower :
         std::set<AutoplayFollower*>(AutoplayFollower::Live())) {
      if (AutoplayFollower::Live().contains(follower)) {
        follower->TellEveryFrame();
      }
    }
  }
  base::DictValue result;
  result.Set("ok", true);
  result.Set("everywhere", g_block_everywhere);
  return result;
}

void RunMediaCommand(content::WebContents* contents, const std::string& script) {
  content::RenderFrameHost* frame =
      contents ? contents->GetPrimaryMainFrame() : nullptr;
  if (frame && frame->IsRenderFrameLive()) {
    ClientOf(frame)->RunArdiaMediaCommand(ISOLATED_WORLD_ID_CHROME_INTERNAL,
                                          script);
  }
}

}
