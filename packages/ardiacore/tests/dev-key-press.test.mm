#import "../ios/ArdiaDevKeyPress.h"

#include <cstdio>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

@interface MenuSink : NSObject
@property(nonatomic) NSMutableArray<NSString *> *fired;
@end

@implementation MenuSink
- (void)record:(NSMenuItem *)item {
  [self.fired addObject:NSStringFromSelector(item.action)];
}
- (void)startDictation:(NSMenuItem *)item { [self record:item]; }
- (void)orderFrontCharacterPalette:(NSMenuItem *)item { [self record:item]; }
- (void)toggleFullScreen:(NSMenuItem *)item { [self record:item]; }
- (void)bookmarkPage:(NSMenuItem *)item { [self record:item]; }
@end

static void Aim(NSMenu *menu, MenuSink *sink) {
  for (NSMenuItem *item in menu.itemArray) {
    if (item.submenu) Aim(item.submenu, sink);
    else item.target = sink;
  }
}

static unsigned short KeyCode(unichar c) {
  switch (c) {
    case 'a': return 0;
    case 'd': return 2;
    case 'e': return 14;
    case 'f': return 3;
    case 'k': return 40;
    case 'p': return 35;
    case 'r': return 15;
    case 's': return 1;
    case 't': return 17;
    case ' ': return 49;
    default: return 0;
  }
}

static NSEvent *KeyDown(NSWindow *window, NSString *chars, NSEventModifierFlags flags) {
  return [NSEvent keyEventWithType:NSEventTypeKeyDown location:NSZeroPoint modifierFlags:flags timestamp:0
                      windowNumber:window.windowNumber context:nil characters:chars charactersIgnoringModifiers:chars
                         isARepeat:NO keyCode:KeyCode([chars.lowercaseString characterAtIndex:0])];
}

int main() {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSMenu *bar = [NSMenu new];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"Edit"];
    [bar addItemWithTitle:@"Edit" action:nil keyEquivalent:@""].submenu = edit;
    [edit addItemWithTitle:@"Bookmark This Page" action:@selector(bookmarkPage:) keyEquivalent:@"d"];
    NSMenu *view = [[NSMenu alloc] initWithTitle:@"View"];
    [bar addItemWithTitle:@"View" action:nil keyEquivalent:@""].submenu = view;
    [view addItemWithTitle:@"Enter Full Screen" action:@selector(toggleFullScreen:) keyEquivalent:@"f"].keyEquivalentModifierMask =
        NSEventModifierFlagControl | NSEventModifierFlagCommand;
    NSApp.mainMenu = bar;
    [NSApp finishLaunching];
    [NSRunLoop.mainRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
    MenuSink *sink = [MenuSink new];
    sink.fired = [NSMutableArray array];
    Aim(bar, sink);

    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 400, 100) styleMask:NSWindowStyleMaskTitled
                                                     backing:NSBackingStoreBuffered defer:YES];
    NSTextView *field = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 400, 100)];
    window.contentView = field;
    [window makeFirstResponder:field];

    NSString *typed = @"defeated keepers";
    for (NSUInteger i = 0; i < typed.length; i++) {
      NSString *c = [typed substringWithRange:NSMakeRange(i, 1)];
      CHECK([ardia_dev::PressKey(window, KeyDown(window, c, 0)) isEqualToString:@"keyDown"]);
    }
    CHECK([field.string isEqualToString:typed]);
    if (![field.string isEqualToString:typed]) std::printf("typed \"%s\"\n", field.string.UTF8String);
    CHECK([ardia_dev::PressKey(window, KeyDown(window, @"E", NSEventModifierFlagShift)) isEqualToString:@"keyDown"]);
    CHECK([field.string hasSuffix:@"E"]);
    CHECK(sink.fired.count == 0);

    CHECK([ardia_dev::PressKey(window, KeyDown(window, @"d", NSEventModifierFlagCommand)) isEqualToString:@"mainMenu"]);
    CHECK([sink.fired.lastObject isEqualToString:@"bookmarkPage:"]);
    CHECK([ardia_dev::PressKey(window, KeyDown(window, @"f", NSEventModifierFlagFunction)) isEqualToString:@"mainMenu"]);
    CHECK([sink.fired.lastObject isEqualToString:@"toggleFullScreen:"]);
    CHECK([ardia_dev::PressKey(window, KeyDown(window, @"e", NSEventModifierFlagFunction)) isEqualToString:@"mainMenu"]);
    CHECK([sink.fired.lastObject isEqualToString:@"orderFrontCharacterPalette:"]);
    CHECK(sink.fired.count == 3);
    CHECK([field.string isEqualToString:[typed stringByAppendingString:@"E"]]);
  }
  if (failures) return 1;
  std::printf("dev-key-press: ok\n");
  return 0;
}
