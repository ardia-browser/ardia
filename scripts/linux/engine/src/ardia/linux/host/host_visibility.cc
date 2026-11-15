// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/core/ac_host_visibility.h"

#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_user_data.h"

namespace ardiacore {

namespace {

class ShownByHostState
    : public content::WebContentsUserData<ShownByHostState> {
 public:
  ~ShownByHostState() override = default;

  bool shown = false;
  bool was_in_shown_slot = false;

 private:
  friend class content::WebContentsUserData<ShownByHostState>;
  explicit ShownByHostState(content::WebContents* contents)
      : content::WebContentsUserData<ShownByHostState>(*contents) {}
  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ShownByHostState);

ShownByHostState* StateOf(content::WebContents* contents) {
  if (!contents) {
    return nullptr;
  }
  ShownByHostState::CreateForWebContents(contents);
  return ShownByHostState::FromWebContents(contents);
}

}

void NoteTabShownByHost(content::WebContents* contents, bool shown) {
  if (ShownByHostState* state = StateOf(contents)) {
    state->shown = shown;
    if (shown) {
      state->was_in_shown_slot = true;
    }
  }
}

std::optional<bool> ShownByHost(content::WebContents* contents) {
  ShownByHostState* state =
      contents ? ShownByHostState::FromWebContents(contents) : nullptr;
  return state ? std::optional<bool>(state->shown) : std::nullopt;
}

void NoteTabInShownSlot(content::WebContents* contents) {
  if (ShownByHostState* state = StateOf(contents)) {
    state->was_in_shown_slot = true;
  }
}

bool TabWasInShownSlot(content::WebContents* contents) {
  ShownByHostState* state =
      contents ? ShownByHostState::FromWebContents(contents) : nullptr;
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
