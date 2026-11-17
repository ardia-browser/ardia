#import <AppKit/AppKit.h>

namespace ardia_dev {

inline NSString *PressKey(NSWindow *window, NSEvent *down) {
  if ([window performKeyEquivalent:down]) return @"window";
  const NSEventModifierFlags menuModifiers = NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagFunction;
  if ((down.modifierFlags & menuModifiers) && [NSApp.mainMenu performKeyEquivalent:down]) return @"mainMenu";
  [window.firstResponder keyDown:down];
  return @"keyDown";
}

}
