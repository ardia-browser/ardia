// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/core/ac_host_visibility.h"

#include <string>

#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/memory/weak_ptr.h"
#include "base/task/single_thread_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/media/webrtc/media_capture_devices_dispatcher.h"
#include "chrome/browser/media/webrtc/media_stream_capture_indicator.h"
#include "chrome/browser/ui/tabs/public/tab_dialog_manager.h"
#include "chrome/browser/ui/tabs/public/tab_features.h"
#include "components/permissions/permission_request_manager.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/visibility.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ardia/core/ac_browser.h"
#include "ardia/core/ac_hooks.h"
#include "ardia/core/ac_picture_in_picture.h"
#include "ardia/core/ac_video_upscaling.h"

namespace ardiacore {

namespace {

constexpr base::TimeDelta kHiddenPageWait = base::Milliseconds(400);
constexpr base::TimeDelta kCallHiddenPageWait = base::Milliseconds(2000);

bool InCall(content::WebContents* contents) {
  return MediaCaptureDevicesDispatcher::GetInstance()
      ->GetMediaStreamCaptureIndicator()
      ->IsCapturingUserMedia(contents);
}

bool g_reading_for_tab_dialogs = false;

void UpdateTabDialogs(content::WebContents* contents) {
  base::AutoReset<bool> for_dialogs(&g_reading_for_tab_dialogs, true);
  if (auto* tab = tabs::TabInterface::MaybeGetFromContents(contents)) {
    if (auto* features = tab->GetTabFeatures()) {
      if (auto* dialogs = features->tab_dialog_manager()) {
        if (dialogs->UpdateDialogVisibility()) {
          dialogs->UpdateModalDialogBounds();
        }
      }
    }
  }
}

class HostVisibility : public content::WebContentsUserData<HostVisibility>,
                       public content::WebContentsObserver {
 public:
  bool shown() const { return shown_; }
  bool shown_until_page_hidden() const {
    return shown_ || (g_reading_for_tab_dialogs ? held_as_shown_ : awaiting_hidden_page_);
  }

  void Note(bool shown) {
    shown_ = shown;
    if (shown || GetWebContents().GetVisibility() != content::Visibility::VISIBLE) {
      StopAwaitingHiddenPage();
      TellAutoPictureInPicture();
      return;
    }
    awaiting_hidden_page_ = true;
    held_as_shown_ = true;
    hide_asked_at_ = base::TimeTicks::Now();
    hidden_page_wait_.Start(FROM_HERE, kHiddenPageWait,
                            base::BindOnce(&HostVisibility::HeldLongEnough,
                                           weak_factory_.GetWeakPtr()));
  }

  void OnVisibilityChanged(content::Visibility visibility) override {
    if (!awaiting_hidden_page_ || visibility == content::Visibility::VISIBLE) {
      return;
    }
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&HostVisibility::PageHiddenOrWaitedOut,
                                  weak_factory_.GetWeakPtr(), "page hidden"));
  }

 private:
  explicit HostVisibility(content::WebContents* contents)
      : content::WebContentsUserData<HostVisibility>(*contents),
        content::WebContentsObserver(contents) {}
  friend class content::WebContentsUserData<HostVisibility>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();

  void HeldLongEnough() {
    if (!awaiting_hidden_page_) {
      return;
    }
    const base::TimeDelta call_left =
        hide_asked_at_ + kCallHiddenPageWait - base::TimeTicks::Now();
    if (!InCall(&GetWebContents()) || !call_left.is_positive()) {
      return PageHiddenOrWaitedOut("waited out");
    }
    held_as_shown_ = false;
    TraceAutoPictureInPictureInputs(&GetWebContents(),
                                    "host hides tab, a call waits for its page to hide");
    UpdateTabDialogs(&GetWebContents());
    hidden_page_wait_.Start(FROM_HERE, call_left,
                            base::BindOnce(&HostVisibility::PageHiddenOrWaitedOut,
                                           weak_factory_.GetWeakPtr(), "call waited out"));
  }

  void PageHiddenOrWaitedOut(const char* why) {
    if (!awaiting_hidden_page_) {
      return;
    }
    StopAwaitingHiddenPage();
    TraceAutoPictureInPictureInputs(&GetWebContents(),
                                    (std::string("host hides tab, ") + why).c_str());
    TellAutoPictureInPicture();
    UpdateTabDialogs(&GetWebContents());
  }

  void StopAwaitingHiddenPage() {
    awaiting_hidden_page_ = false;
    held_as_shown_ = false;
    hidden_page_wait_.Stop();
    weak_factory_.InvalidateWeakPtrs();
  }

  void TellAutoPictureInPicture() {
    ArdiaAutoPictureInPictureHostVisibilityChanged(&GetWebContents());
  }

  bool shown_ = false;
  bool awaiting_hidden_page_ = false;
  bool held_as_shown_ = false;
  base::TimeTicks hide_asked_at_;
  base::OneShotTimer hidden_page_wait_;
  base::WeakPtrFactory<HostVisibility> weak_factory_{this};
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(HostVisibility);

class ShownSlot : public content::WebContentsUserData<ShownSlot> {
 private:
  explicit ShownSlot(content::WebContents* contents)
      : content::WebContentsUserData<ShownSlot>(*contents) {}
  friend class content::WebContentsUserData<ShownSlot>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ShownSlot);

int Answer(content::WebContents* contents) {
  std::optional<bool> shown = ShownByHost(contents);
  return shown ? *shown : -1;
}

int ShownUntilPageHidden(content::WebContents* contents) {
  HostVisibility* state = contents ? HostVisibility::FromWebContents(contents) : nullptr;
  return state ? state->shown_until_page_hidden() : -1;
}

}

std::optional<bool> ShownByHost(content::WebContents* contents) {
  HostVisibility* state = contents ? HostVisibility::FromWebContents(contents) : nullptr;
  return state ? std::optional<bool>(state->shown()) : std::nullopt;
}

void NoteTabShownByHost(content::WebContents* contents, bool shown) {
  if (!contents || ShownByHost(contents) == shown) {
    return;
  }
  HostVisibility::CreateForWebContents(contents);
  TraceAutoPictureInPictureInputs(contents, shown ? "host shows tab" : "host hides tab");
  HostVisibility::FromWebContents(contents)->Note(shown);
  VideoUpscalingInputsChanged();
  if (auto* prompts = permissions::PermissionRequestManager::FromWebContents(contents)) {
    prompts->OnVisibilityChanged(contents->GetVisibility());
  }
  UpdateTabDialogs(contents);
}

void NoteTabInShownSlot(content::WebContents* contents) {
  if (contents && !ShownSlot::FromWebContents(contents)) {
    ShownSlot::CreateForWebContents(contents);
  }
}

bool TabWasInShownSlot(content::WebContents* contents) {
  return contents && ShownSlot::FromWebContents(contents);
}

bool IsAutomationWindow(const BrowserWindowInterface* browser) {
  WindowHost* host = browser ? WindowHost::ForBrowser(browser) : nullptr;
  return host && host->automation();
}

bool InAutomationWindow(content::WebContents* contents) {
  WindowHost* host = contents ? WindowHost::ForContents(contents) : nullptr;
  return host && host->automation();
}

void StartHostVisibility() {
  g_ardia_tab_shown_by_host = &ShownUntilPageHidden;
  g_ardia_permission_tab_shown = &Answer;
}

}
