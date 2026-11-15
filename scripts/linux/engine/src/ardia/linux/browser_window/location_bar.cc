// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/browser_window/browser_window.h"

#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/views/bubble_anchor_util_views.h"
#include "content/public/browser/web_contents.h"
#include "ui/gfx/geometry/rect.h"

namespace ardia_linux {

LocationBarStandIn::LocationBarStandIn() : LocationBar(nullptr) {}
LocationBarStandIn::~LocationBarStandIn() = default;
OmniboxView* LocationBarStandIn::GetOmniboxView() {
  return nullptr;
}
OmniboxPopupView* LocationBarStandIn::GetOmniboxPopupView() {
  return nullptr;
}
OmniboxController* LocationBarStandIn::GetOmniboxController() {
  return nullptr;
}
bool LocationBarStandIn::ShouldCloseOmniboxPopup(ui::MouseEvent* event) {
  return false;
}
content::WebContents* LocationBarStandIn::GetWebContents() {
  return browser_ ? browser_->GetTabStripModel()->GetActiveWebContents()
                  : nullptr;
}
LocationBarModel* LocationBarStandIn::GetLocationBarModel() {
  return nullptr;
}
std::optional<bubble_anchor_util::AnchorConfiguration>
LocationBarStandIn::GetChipAnchor() {
  return std::nullopt;
}
ChipController* LocationBarStandIn::GetChipController() {
  return nullptr;
}
ui::TrackedElement* LocationBarStandIn::GetAnchorOrNull() {
  return nullptr;
}
BrowserWindowInterface* LocationBarStandIn::GetBrowser() {
  return browser_;
}
Profile* LocationBarStandIn::GetProfile() {
  return browser_ ? browser_->GetProfile() : nullptr;
}
bool LocationBarStandIn::IsInitialized() const {
  return true;
}
bool LocationBarStandIn::IsVisible() const {
  return false;
}
bool LocationBarStandIn::IsDrawn() const {
  return false;
}
bool LocationBarStandIn::IsFullscreen() const {
  return false;
}
bool LocationBarStandIn::IsEditingOrEmpty() const {
  return false;
}
bool LocationBarStandIn::IsMouseHovered() const {
  return false;
}
bool LocationBarStandIn::IsFocusWithin() const {
  return false;
}
gfx::Rect LocationBarStandIn::Bounds() const {
  return gfx::Rect();
}
gfx::Rect LocationBarStandIn::BoundsInScreen() const {
  return gfx::Rect();
}
gfx::Size LocationBarStandIn::MinimumSize() const {
  return gfx::Size();
}
gfx::Size LocationBarStandIn::PreferredSize() const {
  return gfx::Size();
}
bool LocationBarStandIn::HasSecurityStateChanged() {
  return false;
}
LocationBarTesting* LocationBarStandIn::GetLocationBarForTesting() {
  return nullptr;
}

}
