// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/browser_window/browser_window.h"

#include "chrome/browser/ui/find_bar/find_bar.h"
#include "chrome/browser/ui/find_bar/find_bar_controller.h"
#include "ui/gfx/range/range.h"

namespace ardia_linux {

FindBarStandIn::FindBarStandIn() = default;
FindBarStandIn::~FindBarStandIn() = default;
FindBarController* FindBarStandIn::GetFindBarController() const {
  return controller_;
}
void FindBarStandIn::SetFindBarController(FindBarController* controller) {
  controller_ = controller;
}
void FindBarStandIn::Show(bool animate, bool focus) {
  visible_ = true;
}
void FindBarStandIn::Hide(bool animate) {
  visible_ = false;
}
void FindBarStandIn::SetFindTextAndSelectedRange(const std::u16string& find_text,
                                            const gfx::Range& selected_range) {
  find_text_ = find_text;
}
std::u16string_view FindBarStandIn::GetFindText() const {
  return find_text_;
}
gfx::Range FindBarStandIn::GetSelectedRange() const {
  return gfx::Range();
}
bool FindBarStandIn::IsFindBarVisible() const {
  return visible_;
}
bool FindBarStandIn::HasGlobalFindPasteboard() const {
  return true;
}
bool FindBarStandIn::CanPopulateFromSelectedText() {
  return true;
}
const FindBarTesting* FindBarStandIn::GetFindBarTesting() const {
  return nullptr;
}
bool FindBarStandIn::HasFocus() const {
  return false;
}
views::Widget* FindBarStandIn::GetHostWidget() {
  return nullptr;
}

}
