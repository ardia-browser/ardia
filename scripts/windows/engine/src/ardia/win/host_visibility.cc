#include "ardia/core/ac_host_visibility.h"

#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"

namespace ardiacore {

namespace {

class HostShown : public content::WebContentsUserData<HostShown> {
 public:
  bool shown = false;
  bool was_in_shown_slot = false;

 private:
  explicit HostShown(content::WebContents* contents)
      : content::WebContentsUserData<HostShown>(*contents) {}
  friend class content::WebContentsUserData<HostShown>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(HostShown);

HostShown& StateOf(content::WebContents* contents) {
  HostShown::CreateForWebContents(contents);
  return *HostShown::FromWebContents(contents);
}

}

void NoteTabShownByHost(content::WebContents* contents, bool shown) {
  if (contents) {
    StateOf(contents).shown = shown;
  }
}

std::optional<bool> ShownByHost(content::WebContents* contents) {
  HostShown* state = contents ? HostShown::FromWebContents(contents) : nullptr;
  return state ? std::optional<bool>(state->shown) : std::nullopt;
}

void NoteTabInShownSlot(content::WebContents* contents) {
  if (contents) {
    StateOf(contents).was_in_shown_slot = true;
  }
}

bool TabWasInShownSlot(content::WebContents* contents) {
  HostShown* state = contents ? HostShown::FromWebContents(contents) : nullptr;
  return state && state->was_in_shown_slot;
}

bool IsAutomationWindow(const BrowserWindowInterface* browser) {
  return false;
}

bool InAutomationWindow(content::WebContents* contents) {
  return false;
}

void StartHostVisibility() {}

}
