#import "ArdiaHoverProbeInternal.h"
#import "ArdiaWindowController.h"

namespace ardia_host {

namespace hover_probe {

NSString *HealRefusalName(HealRefusal refusal) {
  return @[
    @"none", @"notVisible", @"notOnActiveSpace", @"notInFront", @"modalWindow", @"attachedSheet", @"savePanel", @"menuActive", @"menuShown",
    @"fullScreenMoving", @"notClick", @"keyPopup", @"notEligible"
  ][(NSUInteger)refusal];
}

NSString *MenuWindowName(const MenuWindowInfo &info) {
  if (!info.present) return @"none";
  NSString *kind = @[ @"window", @"panel", @"menu", @"sharing", @"tooltip", @"popover", @"fullScreen", @"ardia", @"other" ][(NSUInteger)info.kind];
  NSString *level = @[ @"normal", @"floating", @"raised", @"popUp" ][(NSUInteger)info.level];
  NSString *parent = @[ @"none", @"browser", @"other" ][(NSUInteger)info.parent];
  return [NSString stringWithFormat:@"%@:%@:%@", kind, level, parent];
}

MenuWindowInfo DescribeMenuWindow(NSWindow *window, NSWindow *browser) {
  MenuWindowInfo info;
  info.present = true;
  NSString *name = window.className;
  if ([ArdiaWindowController forNSWindow:window]) info.kind = MenuWindowKind::ardia;
  else if ([name containsString:@"Menu"]) info.kind = MenuWindowKind::menu;
  else if ([name containsString:@"Sharing"]) info.kind = MenuWindowKind::sharing;
  else if ([name localizedCaseInsensitiveContainsString:@"ToolTip"]) info.kind = MenuWindowKind::tooltip;
  else if ([name containsString:@"Popover"]) info.kind = MenuWindowKind::popover;
  else if ([name containsString:@"FullScreen"]) info.kind = MenuWindowKind::fullScreen;
  else if ([window isKindOfClass:NSPanel.class]) info.kind = MenuWindowKind::panel;
  else if (window.class == NSWindow.class) info.kind = MenuWindowKind::window;
  else info.kind = MenuWindowKind::other;
  const NSInteger level = window.level;
  if (level <= NSNormalWindowLevel) info.level = MenuWindowLevel::normal;
  else if (level < NSModalPanelWindowLevel) info.level = MenuWindowLevel::floating;
  else if (level < NSPopUpMenuWindowLevel) info.level = MenuWindowLevel::raised;
  else info.level = MenuWindowLevel::popUp;
  if (!window.parentWindow) info.parent = MenuWindowParent::none;
  else info.parent = window.parentWindow == browser ? MenuWindowParent::browser : MenuWindowParent::other;
  return info;
}

bool MenuShown(NSWindow *browser, MenuWindowInfo *matched) {
  for (NSWindow *window in NSApp.windows) {
    if (window == browser || !window.isVisible) continue;
    if (window.parentWindow == browser || window.level >= NSPopUpMenuWindowLevel || [window.className containsString:@"Menu"]) {
      if (matched) *matched = DescribeMenuWindow(window, browser);
      return true;
    }
  }
  return false;
}

}

}
