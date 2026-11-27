#import <AppKit/AppKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

#import "ArdiaCore.h"
#import "bridge.h"
#import "pip/ACPiPHost.h"

@interface ACPageCover : NSView
+ (void)coverTab:(ArdiaCoreTab *)tab then:(void (^)(BOOL covered))then;
- (void)uncover:(BOOL)fade;
@end

@implementation ACPageCover {
  CGImageRef _picture;
}

+ (void)coverTab:(ArdiaCoreTab *)tab then:(void (^)(BOOL covered))then {
  NSView *page = tab.view;
  if (!page.window || page.isHiddenOrHasHiddenAncestor) return then(NO);
  __weak ArdiaCoreTab *weakTab = tab;
  __weak NSWindow *weakWindow = page.window;
  __weak NSView *weakHost = page.superview;
  [tab copyPicture:0.25
        completion:^(CGImageRef picture) {
          ArdiaCoreTab *t = weakTab;
          NSView *now = t.view;
          if (!picture || !now.window || now.window != weakWindow || now.superview != weakHost) return then(NO);
          for (NSView *view in now.subviews.copy)
            if ([view isKindOfClass:ACPageCover.class]) [view removeFromSuperview];
          ACPageCover *cover = [[ACPageCover alloc] initWithFrame:now.bounds picture:picture];
          [now addSubview:cover];
          [cover displayIfNeeded];
          then(YES);
        }];
}

- (instancetype)initWithFrame:(NSRect)frame picture:(CGImageRef)picture {
  if ((self = [super initWithFrame:frame])) {
    _picture = CGImageRetain(picture);
    self.wantsLayer = YES;
    self.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.layer.contents = (__bridge id)_picture;
    self.layer.contentsGravity = kCAGravityResize;
    __weak ACPageCover *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [weakSelf uncover:NO];
    });
  }
  return self;
}

- (void)dealloc {
  CGImageRelease(_picture);
}

- (BOOL)wantsUpdateLayer {
  return YES;
}

- (void)updateLayer {
  self.layer.contents = (__bridge id)_picture;
  self.layer.contentsGravity = kCAGravityResize;
}

- (NSView *)hitTest:(NSPoint)point {
  return nil;
}

- (BOOL)isAccessibilityElement {
  return NO;
}

- (void)uncover:(BOOL)fade {
  if (!self.superview) return;
  if (!fade) return [self removeFromSuperview];
  [NSAnimationContext
      runAnimationGroup:^(NSAnimationContext *context) {
        context.duration = 0.1;
        self.animator.alphaValue = 0;
      }
      completionHandler:^{
        [self removeFromSuperview];
      }];
}

@end


#include <libproc.h>
#include <sys/param.h>
#include <atomic>
#include <climits>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <initializer_list>
#include <map>
#include <pthread.h>
#include <utility>

namespace {

ArdiaBridgeHost gHost = {};
std::atomic<bool> gHostInstalled{false};
bool gRunning = false;
bool gStarted = false;
NSString *gPageScript = nil;
bool gPageScriptPending = false;
bool gScrollObserverWanted = false;
std::atomic<bool> gGuardInstalled{false};

NSString *const kBadArgument = @"ArdiaBadArgument";

[[noreturn]] void Bad(NSString *what) {
  @throw [NSException exceptionWithName:kBadArgument reason:what userInfo:nil];
}

NSString *Text(const char *text) {
  return text ? [NSString stringWithUTF8String:text] : nil;
}

char *Copy(NSString *text) {
  const char *utf8 = text.UTF8String;
  return utf8 ? strdup(utf8) : nullptr;
}

id Plain(id value, int depth) {
  if (!value || value == NSNull.null || depth > 32) return NSNull.null;
  if ([value isKindOfClass:NSString.class]) return value;
  if ([value isKindOfClass:NSNumber.class]) return std::isfinite([value doubleValue]) ? value : NSNull.null;
  if ([value isKindOfClass:NSArray.class]) {
    NSMutableArray *out = [NSMutableArray arrayWithCapacity:[value count]];
    for (id item in (NSArray *)value) [out addObject:Plain(item, depth + 1)];
    return out;
  }
  if ([value isKindOfClass:NSDictionary.class]) {
    NSMutableDictionary *out = [NSMutableDictionary dictionaryWithCapacity:[value count]];
    [(NSDictionary *)value enumerateKeysAndObjectsUsingBlock:^(id key, id object, BOOL *) {
      if ([key isKindOfClass:NSString.class]) out[key] = Plain(object, depth + 1);
    }];
    return out;
  }
  if ([value isKindOfClass:NSURL.class]) return [(NSURL *)value absoluteString] ?: NSNull.null;
  if ([value isKindOfClass:NSDate.class]) return @([(NSDate *)value timeIntervalSince1970] * 1000);
  if ([value isKindOfClass:NSData.class]) return [(NSData *)value base64EncodedStringWithOptions:0];
  return NSNull.null;
}

NSString *JSONText(id object) {
  id plain = Plain(object, 0);
  if (![plain isKindOfClass:NSDictionary.class] && ![plain isKindOfClass:NSArray.class]) return nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:plain options:0 error:nil];
  return data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
}

NSDictionary *Parse(const char *json) {
  if (!json) return @{};
  NSData *data = [NSData dataWithBytesNoCopy:(void *)json length:strlen(json) freeWhenDone:NO];
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![parsed isKindOfClass:NSDictionary.class]) Bad(@"arguments must be a JSON object");
  return parsed;
}

NSString *Str(NSDictionary *args, NSString *key) {
  id value = args[key];
  if ([value isKindOfClass:NSString.class]) return value;
  Bad([NSString stringWithFormat:@"%@ must be text", key]);
}

NSString *OptStr(NSDictionary *args, NSString *key) {
  id value = args[key];
  return [value isKindOfClass:NSString.class] ? value : nil;
}

double Num(NSDictionary *args, NSString *key) {
  id value = args[key];
  if ([value isKindOfClass:NSNumber.class] && std::isfinite([value doubleValue])) return [value doubleValue];
  Bad([NSString stringWithFormat:@"%@ must be a number", key]);
}

double OptNum(NSDictionary *args, NSString *key, double fallback) {
  id value = args[key];
  return [value isKindOfClass:NSNumber.class] && std::isfinite([value doubleValue]) ? [value doubleValue] : fallback;
}

bool IntegerValue(id value, int64_t low, int64_t high, int64_t *out) {
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return false;
  NSNumber *number = value;
  int64_t whole = 0;
  if (CFNumberIsFloatType((__bridge CFNumberRef)number)) {
    const double real = number.doubleValue;
    if (!std::isfinite(real) || real != std::floor(real) || real < -0x1p63 || real >= 0x1p63) return false;
    whole = (int64_t)real;
  } else if (strcmp(number.objCType, @encode(unsigned long long)) == 0 || strcmp(number.objCType, @encode(unsigned long)) == 0) {
    const unsigned long long big = number.unsignedLongLongValue;
    if (big > (unsigned long long)INT64_MAX) return false;
    whole = (int64_t)big;
  } else {
    whole = number.longLongValue;
  }
  if (whole < low || whole > high) return false;
  *out = whole;
  return true;
}

int64_t Integer(NSDictionary *args, NSString *key, int64_t low, int64_t high) {
  int64_t whole = 0;
  if (!IntegerValue(args[key], low, high, &whole)) Bad([NSString stringWithFormat:@"%@ must be a whole number in range", key]);
  return whole;
}

int Int(NSDictionary *args, NSString *key) {
  return (int)Integer(args, key, INT_MIN, INT_MAX);
}

bool Flag(NSDictionary *args, NSString *key) {
  id value = args[key];
  return [value isKindOfClass:NSNumber.class] && [value boolValue];
}

bool Absent(NSDictionary *args, NSString *key) {
  id value = args[key];
  return value == nil || value == NSNull.null;
}

uint64_t Ident(NSDictionary *args, NSString *key) {
  int64_t whole = 0;
  return IntegerValue(args[key], 1, INT64_MAX, &whole) ? (uint64_t)whole : 0;
}

NSArray *List(NSDictionary *args, NSString *key) {
  id value = args[key];
  return [value isKindOfClass:NSArray.class] ? value : @[];
}

NSArray<NSString *> *Strings(NSDictionary *args, NSString *key) {
  NSMutableArray<NSString *> *out = [NSMutableArray array];
  for (id item in List(args, key))
    if ([item isKindOfClass:NSString.class]) [out addObject:item];
  return out;
}

void SetOut(char **out, id value) {
  if (out) *out = Copy(JSONText(@{@"value" : value ?: NSNull.null}));
}

bool Hosted() {
  return gHostInstalled.load(std::memory_order_acquire);
}

void Emit(NSDictionary *event) {
  if (!Hosted() || !gHost.event) return;
  @try {
    NSString *json = JSONText(event);
    if (json) gHost.event(gHost.context, json.UTF8String);
  } @catch (NSException *exception) {
    NSLog(@"[ardia-engine] dropped an event: %@", exception.reason);
  }
}

bool Decide(NSDictionary *question, bool fallback) {
  if (!Hosted() || !gHost.decide) return fallback;
  NSString *json = JSONText(question);
  if (!json) return fallback;
  const int32_t answer = gHost.decide(gHost.context, json.UTF8String);
  return answer < 0 ? fallback : answer != 0;
}

id Answer(NSDictionary *question) {
  if (!Hosted() || !gHost.answer) return nil;
  NSString *json = JSONText(question);
  if (!json) return nil;
  char *reply = gHost.answer(gHost.context, json.UTF8String);
  if (!reply) return nil;
  NSData *data = [NSData dataWithBytes:reply length:strlen(reply)];
  if (gHost.release_answer) gHost.release_answer(gHost.context, reply);
  id parsed = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil];
  return parsed == NSNull.null ? nil : parsed;
}

void Complete(uint64_t request, int32_t status, NSDictionary *payload, NSData *bytes) {
  if (!Hosted() || !gHost.complete || !request) return;
  NSString *json = payload ? JSONText(payload) : nil;
  gHost.complete(gHost.context, request, status, json.UTF8String, (const uint8_t *)bytes.bytes, bytes.length);
}

Class EngineClass() {
  return NSClassFromString(@"ArdiaCoreEngine");
}

Class WindowClass() {
  return NSClassFromString(@"ArdiaCoreWindow");
}

Class PageViewClass() {
  return NSClassFromString(@"ArdiaCorePageView");
}

ArdiaCoreEngine *SharedEngine() {
  Class engine = EngineClass();
  return engine ? [engine sharedEngine] : nil;
}

}

namespace guard {
bool Owns(Class cls, SEL selector);
}

namespace hosted {

const void *const kHostedClassKey = &kHostedClassKey;
ArdiaHostedWindowHooks gHooks = {};
std::atomic<bool> gActive{false};

struct Patch {
  IMP ours = nullptr;
  IMP original = nullptr;
  bool added = false;
  bool live = false;
  std::atomic<uint64_t> generation{0};
};

using PatchKey = std::pair<uintptr_t, uintptr_t>;

std::map<PatchKey, Patch> &Patches() {
  static std::map<PatchKey, Patch> patches;
  return patches;
}

PatchKey KeyOf(Class cls, SEL selector) {
  return {reinterpret_cast<uintptr_t>((__bridge void *)cls), reinterpret_cast<uintptr_t>(selector)};
}

NSHashTable<NSWindow *> *Attached() {
  static NSHashTable *attached = [NSHashTable weakObjectsHashTable];
  return attached;
}

bool Active() {
  return gActive.load(std::memory_order_acquire);
}

bool Routes(id window, Class cls) {
  return window && Active() && pthread_main_np() != 0 &&
         (__bridge void *)objc_getAssociatedObject(window, kHostedClassKey) == (__bridge void *)cls;
}

IMP Next(Class cls, SEL selector, IMP original) {
  return original ?: class_getMethodImplementation(class_getSuperclass(cls), selector);
}

struct VoidCall {
  IMP imp;
  __unsafe_unretained id target;
  SEL selector;
  __unsafe_unretained id argument;
  bool called;
  __strong id thrown;
};

struct BoolCall {
  IMP imp;
  __unsafe_unretained id target;
  SEL selector;
  __unsafe_unretained id argument;
  bool called;
  bool result;
  __strong id thrown;
};

void CallVoid(void *thunk) {
  VoidCall *call = static_cast<VoidCall *>(thunk);
  if (!call || call->called) return;
  call->called = true;
  @try {
    reinterpret_cast<void (*)(id, SEL, id)>(call->imp)(call->target, call->selector, call->argument);
  } @catch (id thrown) {
    call->thrown = thrown;
  }
}

bool CallBool(void *thunk) {
  BoolCall *call = static_cast<BoolCall *>(thunk);
  if (!call) return false;
  if (call->called) return call->result;
  call->called = true;
  @try {
    call->result = reinterpret_cast<BOOL (*)(id, SEL, id)>(call->imp)(call->target, call->selector, call->argument);
  } @catch (id thrown) {
    call->thrown = thrown;
  }
  return call->result;
}

using VoidHook = void (*)(void *, void *, void *, ArdiaHostedVoidSuper, void *);
using BoolHook = bool (*)(void *, void *, void *, ArdiaHostedBoolSuper, void *);

using Generation = const std::atomic<uint64_t> *;

bool Current(Generation current, uint64_t generation) {
  return current->load(std::memory_order_acquire) == generation;
}

IMP VoidBlock(Class cls, SEL selector, IMP original, Generation current, uint64_t generation,
              VoidHook ArdiaHostedWindowHooks::*slot) {
  return imp_implementationWithBlock(^(NSWindow *window, NSEvent *event) {
    IMP next = Next(cls, selector, original);
    const bool routes = event && Current(current, generation) && Routes(window, cls);
    const ArdiaHostedWindowHooks hooks = routes ? gHooks : ArdiaHostedWindowHooks{};
    VoidHook hook = hooks.*slot;
    if (!hook) {
      reinterpret_cast<void (*)(id, SEL, id)>(next)(window, selector, event);
      return;
    }
    VoidCall call{next, window, selector, event, false, nil};
    hook(hooks.context, (__bridge void *)window, (__bridge void *)event, CallVoid, &call);
    if (call.thrown) @throw call.thrown;
  });
}

IMP BoolBlock(Class cls, SEL selector, IMP original, Generation current, uint64_t generation,
              BoolHook ArdiaHostedWindowHooks::*slot, bool needsArgument) {
  return imp_implementationWithBlock(^BOOL(NSWindow *window, id argument) {
    IMP next = Next(cls, selector, original);
    const bool routes = (argument || !needsArgument) && Current(current, generation) && Routes(window, cls);
    const ArdiaHostedWindowHooks hooks = routes ? gHooks : ArdiaHostedWindowHooks{};
    BoolHook hook = hooks.*slot;
    if (!hook) {
      return reinterpret_cast<BOOL (*)(id, SEL, id)>(next)(window, selector, argument);
    }
    BoolCall call{next, window, selector, argument, false, false, nil};
    const bool answer = hook(hooks.context, (__bridge void *)window, (__bridge void *)argument, CallBool, &call);
    if (call.thrown) @throw call.thrown;
    return answer ? YES : NO;
  });
}

IMP MakeHook(Class cls, SEL selector, IMP original, Generation current, uint64_t generation) {
  if (selector == @selector(sendEvent:))
    return VoidBlock(cls, selector, original, current, generation, &ArdiaHostedWindowHooks::send_event);
  if (selector == @selector(keyDown:))
    return VoidBlock(cls, selector, original, current, generation, &ArdiaHostedWindowHooks::key_down);
  if (selector == @selector(makeFirstResponder:))
    return BoolBlock(cls, selector, original, current, generation, &ArdiaHostedWindowHooks::make_first_responder,
                     false);
  return BoolBlock(cls, selector, original, current, generation, &ArdiaHostedWindowHooks::perform_key_equivalent,
                   true);
}

const SEL *Selectors(size_t *count) {
  static const SEL selectors[] = {@selector(sendEvent:), @selector(keyDown:), @selector(makeFirstResponder:),
                                  @selector(performKeyEquivalent:)};
  *count = sizeof(selectors) / sizeof(selectors[0]);
  return selectors;
}

bool Install(Class cls, SEL selector) {
  Method inherited = class_getInstanceMethod(cls, selector);
  if (!inherited) return false;
  Patch &patch = Patches()[KeyOf(cls, selector)];
  const bool owns = guard::Owns(cls, selector);
  IMP current = method_getImplementation(inherited);
  if (owns && patch.ours && current == patch.ours) {
    patch.live = true;
    return true;
  }
  const uint64_t generation = patch.generation.load(std::memory_order_relaxed) + 1;
  IMP ours = MakeHook(cls, selector, owns ? current : nullptr, &patch.generation, generation);
  if (owns) {
    method_setImplementation(inherited, ours);
  } else if (!class_addMethod(cls, selector, ours, method_getTypeEncoding(inherited))) {
    imp_removeBlock(ours);
    return false;
  }
  patch.generation.store(generation, std::memory_order_release);
  patch.ours = ours;
  patch.original = owns ? current : nullptr;
  patch.added = !owns;
  patch.live = true;
  return true;
}

uint64_t RestoreAll() {
  uint64_t restored = 0;
  for (auto &entry : Patches()) {
    Patch &patch = entry.second;
    if (!patch.live) continue;
    patch.live = false;
    if (patch.added) continue;
    Class cls = (__bridge Class)reinterpret_cast<void *>(entry.first.first);
    SEL selector = reinterpret_cast<SEL>(entry.first.second);
    Method method = guard::Owns(cls, selector) ? class_getInstanceMethod(cls, selector) : nullptr;
    if (method && method_getImplementation(method) == patch.ours) {
      method_setImplementation(method, patch.original);
      restored++;
    }
  }
  return restored;
}

ArdiaBridgeStatus Attach(NSWindow *window) {
  if (!Active()) return ARDIA_BRIDGE_NO_HOST;
  if (![window isKindOfClass:NSWindow.class]) return ARDIA_BRIDGE_BAD_ARGUMENT;
  Class cls = [window class];
  size_t count = 0;
  const SEL *selectors = Selectors(&count);
  for (size_t i = 0; i < count; i++)
    if (!Install(cls, selectors[i])) return ARDIA_BRIDGE_FAILED;
  objc_setAssociatedObject(window, kHostedClassKey, cls, OBJC_ASSOCIATION_ASSIGN);
  [Attached() addObject:window];
  return ARDIA_BRIDGE_OK;
}

void Detach(NSWindow *window) {
  objc_setAssociatedObject(window, kHostedClassKey, nil, OBJC_ASSOCIATION_ASSIGN);
  [Attached() removeObject:window];
}

void AttachIfActive(NSWindow *window) {
  if (window && Active() && Attach(window) != ARDIA_BRIDGE_OK)
    NSLog(@"[ardia-engine] couldn't route input for window %ld", (long)window.windowNumber);
}

bool SameHooks(const ArdiaHostedWindowHooks &a, const ArdiaHostedWindowHooks &b) {
  return a.context == b.context && a.send_event == b.send_event && a.key_down == b.key_down &&
         a.make_first_responder == b.make_first_responder && a.perform_key_equivalent == b.perform_key_equivalent;
}

}

@interface ABCompletion : NSObject
- (instancetype)initWithRequest:(uint64_t)request;
- (void)finish:(nullable NSDictionary *)payload;
- (void)finishBytes:(nullable NSData *)bytes;
- (void)fail:(NSString *)message;
@end

@implementation ABCompletion {
  std::atomic<bool> _done;
  uint64_t _request;
}

- (instancetype)initWithRequest:(uint64_t)request {
  if ((self = [super init])) {
    _request = request;
    _done.store(false);
  }
  return self;
}

- (bool)claim {
  bool expected = false;
  return _done.compare_exchange_strong(expected, true);
}

- (void)finish:(NSDictionary *)payload {
  if ([self claim]) Complete(_request, ARDIA_COMPLETION_OK, payload ?: @{}, nil);
}

- (void)finishBytes:(NSData *)bytes {
  if ([self claim]) Complete(_request, ARDIA_COMPLETION_OK, @{@"bytes" : @(bytes != nil)}, bytes);
}

- (void)fail:(NSString *)message {
  if ([self claim]) Complete(_request, ARDIA_COMPLETION_ERROR, @{@"error" : message ?: @"failed"}, nil);
}

- (void)dealloc {
  if ([self claim]) Complete(_request, ARDIA_COMPLETION_CANCELLED, nil, nil);
}

@end

@interface ABRegistry : NSObject
- (uint64_t)idFor:(nullable id)object;
- (uint64_t)knownIdFor:(nullable id)object;
- (nullable id)objectFor:(uint64_t)ident;
- (void)hold:(uint64_t)ident;
- (void)drop:(uint64_t)ident;
- (NSArray *)liveObjects;
@end

@implementation ABRegistry {
  NSMapTable *_ids;
  NSMapTable *_objects;
  NSMutableDictionary<NSNumber *, id> *_strong;
  uint64_t _next;
}

- (instancetype)init {
  if ((self = [super init])) {
    _ids = [NSMapTable mapTableWithKeyOptions:NSPointerFunctionsWeakMemory | NSPointerFunctionsObjectPointerPersonality
                                 valueOptions:NSPointerFunctionsStrongMemory];
    _objects = [NSMapTable strongToWeakObjectsMapTable];
    _strong = [NSMutableDictionary dictionary];
  }
  return self;
}

- (uint64_t)idFor:(id)object {
  if (!object) return 0;
  NSNumber *known = [_ids objectForKey:object];
  if (known) return known.unsignedLongLongValue;
  const uint64_t ident = ++_next;
  [_ids setObject:@(ident) forKey:object];
  [_objects setObject:object forKey:@(ident)];
  return ident;
}

- (uint64_t)knownIdFor:(id)object {
  NSNumber *known = object ? [_ids objectForKey:object] : nil;
  return known.unsignedLongLongValue;
}

- (id)objectFor:(uint64_t)ident {
  return ident ? [_objects objectForKey:@(ident)] : nil;
}

- (void)hold:(uint64_t)ident {
  if (id object = [self objectFor:ident]) _strong[@(ident)] = object;
}

- (void)drop:(uint64_t)ident {
  [_strong removeObjectForKey:@(ident)];
}

- (NSArray *)liveObjects {
  return _objects.objectEnumerator.allObjects;
}

@end

namespace {

ABRegistry *Windows() {
  static ABRegistry *registry = [ABRegistry new];
  return registry;
}

ABRegistry *Tabs() {
  static ABRegistry *registry = [ABRegistry new];
  return registry;
}

ABRegistry *Profiles() {
  static ABRegistry *registry = [ABRegistry new];
  return registry;
}

NSMutableDictionary<NSNumber *, void (^)(BOOL)> *DownloadConfirms() {
  static NSMutableDictionary *confirms = [NSMutableDictionary dictionary];
  return confirms;
}

NSUInteger ReleaseConfirms(BOOL close_anyway) {
  NSDictionary *pending = [DownloadConfirms() copy];
  [DownloadConfirms() removeAllObjects];
  for (void (^confirm)(BOOL) in pending.allValues) confirm(close_anyway);
  return pending.count;
}

uint64_t gNextConfirm = 0;

}

@interface ABEngineDelegate : NSObject <ArdiaCoreEngineDelegate>
@end

@interface ABWindowDelegate : NSObject <ArdiaCoreWindowDelegate>
@end

@interface ABTabDelegate : NSObject <ArdiaCoreTabDelegate>
@end

@interface ABScrollObserver : NSObject <ArdiaCorePageScrollObserver>
@end

namespace {

ABEngineDelegate *EngineDelegate() {
  static ABEngineDelegate *delegate = [ABEngineDelegate new];
  return delegate;
}

ABWindowDelegate *WindowDelegate() {
  static ABWindowDelegate *delegate = [ABWindowDelegate new];
  return delegate;
}

ABTabDelegate *TabDelegate() {
  static ABTabDelegate *delegate = [ABTabDelegate new];
  return delegate;
}

ABScrollObserver *ScrollObserver() {
  static ABScrollObserver *observer = [ABScrollObserver new];
  return observer;
}

uint64_t TabIdent(ArdiaCoreTab *tab) {
  if (!tab) return 0;
  const uint64_t ident = [Tabs() idFor:tab];
  if (tab.delegate != (id)TabDelegate()) tab.delegate = TabDelegate();
  return ident;
}

uint64_t ProfileIdent(ArdiaCoreProfile *profile) {
  return [Profiles() idFor:profile];
}

uint64_t HeldProfileIdent(ArdiaCoreProfile *profile) {
  const uint64_t ident = ProfileIdent(profile);
  [Profiles() hold:ident];
  return ident;
}

uint64_t WindowIdent(ArdiaCoreWindow *window) {
  return [Windows() knownIdFor:window];
}

void ObserveClose(ArdiaCoreWindow *coreWindow, uint64_t ident) {
  NSWindow *window = coreWindow.window;
  if (!window) return;
  __block id observer = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification
                                                                       object:window
                                                                        queue:nil
                                                                   usingBlock:^(NSNotification *) {
                                                                     [NSNotificationCenter.defaultCenter removeObserver:observer];
                                                                     observer = nil;
                                                                     Emit(@{@"event" : @"windowClosed", @"window" : @(ident)});
                                                                     dispatch_async(dispatch_get_main_queue(), ^{
                                                                       [Windows() drop:ident];
                                                                     });
                                                                   }];
}

void StyleBrowserWindow(NSWindow *window) {
  const NSRect frame = window.frame;
  window.styleMask |= NSWindowStyleMaskFullSizeContentView;
  if (!NSEqualRects(window.frame, frame)) [window setFrame:frame display:NO];
  window.titlebarAppearsTransparent = YES;
  window.titleVisibility = NSWindowTitleHidden;
  window.title = @"Ardia";
  window.contentMinSize = NSMakeSize(500, 460);
  window.releasedWhenClosed = NO;
  window.tabbingMode = NSWindowTabbingModeDisallowed;
}

ArdiaCoreWindow *MakeWindow(NSRect rect) {
  Class windowClass = WindowClass();
  if (!windowClass) return nil;
  ArdiaCoreWindow *window = [[windowClass alloc] initWithContentRect:rect];
  if (!window || !window.window) return nil;
  StyleBrowserWindow(window.window);
  window.delegate = WindowDelegate();
  const uint64_t ident = [Windows() idFor:window];
  [Windows() hold:ident];
  ObserveClose(window, ident);
  hosted::AttachIfActive(window.window);
  return window;
}

ArdiaCoreTab *TabFor(uint64_t ident) {
  ArdiaCoreTab *tab = [Tabs() objectFor:ident];
  return tab.closed ? nil : tab;
}

ArdiaCoreProfile *ProfileFor(uint64_t ident) {
  ArdiaCoreProfile *profile = [Profiles() objectFor:ident];
  return profile.destroyed ? nil : profile;
}

ArdiaCoreTab *NeedTab(NSDictionary *args, NSString *key) {
  ArdiaCoreTab *tab = TabFor(Ident(args, key));
  if (!tab) Bad([NSString stringWithFormat:@"%@ is not an open tab", key]);
  return tab;
}

ArdiaCoreProfile *NeedProfile(NSDictionary *args, NSString *key) {
  ArdiaCoreProfile *profile = ProfileFor(Ident(args, key));
  if (!profile) Bad([NSString stringWithFormat:@"%@ is not a loaded profile", key]);
  return profile;
}

NSDictionary *KeyEventDict(NSEvent *event) {
  const bool key = event.type == NSEventTypeKeyDown || event.type == NSEventTypeKeyUp;
  const bool flags = event.type == NSEventTypeFlagsChanged;
  return @{
    @"kind" : event.type == NSEventTypeKeyDown ? @"down" : event.type == NSEventTypeKeyUp ? @"up" : @"flagsChanged",
    @"keyCode" : @(key || flags ? event.keyCode : 0),
    @"characters" : key ? (event.characters ?: @"") : @"",
    @"charactersIgnoringModifiers" : key ? (event.charactersIgnoringModifiers ?: @"") : @"",
    @"modifiers" : @(event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask),
    @"isRepeat" : @(key && event.isARepeat),
  };
}

NSDictionary *WithKeyEvent(NSDictionary *base, NSEvent *event) {
  NSMutableDictionary *question = [base mutableCopy];
  question[@"event"] = KeyEventDict(event);
  return question;
}

NSColor *ColorFrom(id value) {
  if (![value isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *color = value;
  return [NSColor colorWithSRGBRed:OptNum(color, @"r", 0) green:OptNum(color, @"g", 0) blue:OptNum(color, @"b", 0) alpha:OptNum(color, @"a", 1)];
}

NSArray<NSDictionary<NSString *, NSString *> *> *MenuItems(id answer) {
  NSMutableArray *items = [NSMutableArray array];
  if (![answer isKindOfClass:NSArray.class]) return items;
  for (id item in (NSArray *)answer) {
    if (![item isKindOfClass:NSDictionary.class]) continue;
    NSString *ident = OptStr(item, @"id");
    NSString *title = OptStr(item, @"title");
    if (ident.length && title.length) [items addObject:@{@"id" : ident, @"title" : title}];
  }
  return items;
}

void ApplyPageScript() {
  ArdiaCoreEngine *engine = SharedEngine();
  if (!engine) return;
  engine.pageScript = gPageScript;
  gPageScriptPending = false;
}

bool Listening() {
  return Decide(@{@"question" : @"listening"}, false);
}

}

@implementation ABEngineDelegate

- (void)engineDidStart {
  gStarted = true;
  ardia_pip::Install();
  if (gPageScriptPending) ApplyPageScript();
  if (gScrollObserverWanted) [PageViewClass() setScrollObserver:ScrollObserver()];
  if (gGuardInstalled.load() && NSApp) [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
  if (ArdiaCoreProfile *profile = SharedEngine().defaultProfile) HeldProfileIdent(profile);
  Emit(@{@"event" : @"started"});
}

- (void)engineWillShutDown {
  gStarted = false;
  Emit(@{@"event" : @"willShutDown"});
  ReleaseConfirms(YES);
}

- (void)engineQuitCancelled {
  Emit(@{@"event" : @"quitCancelled"});
}

- (ArdiaCoreWindow *)engineWindowForNewBrowserOfProfile:(ArdiaCoreProfile *)profile type:(NSString *)type {
  const uint64_t profileId = ProfileIdent(profile);
  const uint64_t answer = Hosted() && gHost.new_window ? gHost.new_window(gHost.context, profileId, type.UTF8String ?: "") : 0;
  if (!answer) return nil;
  if (answer != ARDIA_BRIDGE_CREATE_WINDOW) {
    ArdiaCoreWindow *existing = [Windows() objectFor:answer];
    return existing.window ? existing : nil;
  }
  ArdiaCoreWindow *window = MakeWindow(NSMakeRect(0, 0, 1360, 860));
  if (!window) return nil;
  Emit(@{@"event" : @"windowCreatedByEngine", @"window" : @(WindowIdent(window)), @"profile" : @(profileId), @"kind" : type ?: @""});
  return window;
}

- (void)engine:(ArdiaCoreEngine *)engine permissionRequest:(NSDictionary<NSString *, id> *)request tab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"permissionRequest", @"tab" : @(TabIdent(tab)), @"request" : request ?: @{}});
}

- (void)engine:(ArdiaCoreEngine *)engine permissionRequestDismissed:(NSString *)requestId {
  Emit(@{@"event" : @"permissionDismissed", @"requestId" : requestId ?: @""});
}

- (void)engine:(ArdiaCoreEngine *)engine extensionSidePanel:(NSDictionary<NSString *, id> *)panel tab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"extensionSidePanel", @"tab" : @(TabIdent(tab)), @"panel" : panel ?: @{}});
}

- (BOOL)engine:(ArdiaCoreEngine *)engine extensionActionPopup:(NSDictionary<NSString *, id> *)popup tab:(ArdiaCoreTab *)tab {
  const uint64_t tabId = TabIdent(tab);
  NSDictionary *payload = popup ?: @{};
  if (!Decide(@{@"question" : @"extensionActionPopup", @"tab" : @(tabId), @"payload" : payload}, false)) return NO;
  Emit(@{@"event" : @"extensionActionPopup", @"tab" : @(tabId), @"popup" : payload});
  return YES;
}

- (BOOL)engine:(ArdiaCoreEngine *)engine extensionActionShortcut:(NSDictionary<NSString *, id> *)shortcut tab:(ArdiaCoreTab *)tab {
  const uint64_t tabId = TabIdent(tab);
  NSDictionary *payload = shortcut ?: @{};
  if (!Decide(@{@"question" : @"extensionActionShortcut", @"tab" : @(tabId), @"payload" : payload}, false)) return NO;
  Emit(@{@"event" : @"extensionActionShortcut", @"tab" : @(tabId), @"shortcut" : payload});
  return YES;
}

- (BOOL)engineIsReservedKeyEvent:(NSEvent *)event {
  if (event.type != NSEventTypeKeyDown) return NO;
  return Decide(WithKeyEvent(@{@"question" : @"reservedKeyEvent"}, event), false);
}

- (BOOL)engineIsReservedKey:(NSString *)key unshiftedKey:(NSString *)unshiftedKey modifiers:(NSEventModifierFlags)modifiers {
  return Decide(@{
    @"question" : @"reservedKey",
    @"key" : key ?: @"",
    @"unshiftedKey" : unshiftedKey ?: @"",
    @"modifiers" : @(modifiers & NSEventModifierFlagDeviceIndependentFlagsMask)
  },
                false);
}

- (void)engine:(ArdiaCoreEngine *)engine
    extensionInstallPrompt:(NSDictionary<NSString *, id> *)prompt
                   profile:(ArdiaCoreProfile *)profile
                       tab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"extensionInstallPrompt", @"profile" : @(ProfileIdent(profile)), @"tab" : @(TabIdent(tab)), @"prompt" : prompt ?: @{}});
}

- (void)engine:(ArdiaCoreEngine *)engine extensionInstallFailed:(NSString *)message tab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"extensionInstallFailed", @"tab" : @(TabIdent(tab)), @"message" : message ?: @""});
}

- (void)engine:(ArdiaCoreEngine *)engine deviceChooser:(NSDictionary<NSString *, id> *)chooser tab:(ArdiaCoreTab *)tab {
  if (!Listening()) {
    if ([chooser[@"open"] boolValue]) [EngineClass() cancelDeviceChooser:[chooser[@"id"] intValue]];
    return;
  }
  Emit(@{@"event" : @"deviceChooser", @"tab" : @(TabIdent(tab)), @"chooser" : chooser ?: @{}});
}

- (void)engine:(ArdiaCoreEngine *)engine castDialog:(NSDictionary<NSString *, id> *)dialog tab:(ArdiaCoreTab *)tab {
  if (!Listening()) {
    if ([dialog[@"open"] boolValue]) [EngineClass() closeCastDialog:[dialog[@"id"] intValue]];
    return;
  }
  Emit(@{@"event" : @"castDialog", @"tab" : @(TabIdent(tab)), @"dialog" : dialog ?: @{}});
}

- (void)engine:(ArdiaCoreEngine *)engine castRoutes:(NSArray<NSDictionary<NSString *, NSString *> *> *)routes profile:(ArdiaCoreProfile *)profile {
  Emit(@{@"event" : @"castRoutes", @"profile" : @(ProfileIdent(profile)), @"routes" : routes ?: @[]});
}

@end

@implementation ABWindowDelegate

- (void)window:(ArdiaCoreWindow *)window didInsertTab:(ArdiaCoreTab *)tab opener:(ArdiaCoreTab *)opener disposition:(NSString *)disposition {
  Emit(@{
    @"event" : @"tabInserted",
    @"window" : @(WindowIdent(window)),
    @"tab" : @(TabIdent(tab)),
    @"opener" : @(TabIdent(opener)),
    @"disposition" : disposition ?: @""
  });
}

- (void)window:(ArdiaCoreWindow *)window didRemoveTab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"tabRemoved", @"window" : @(WindowIdent(window)), @"tab" : @(TabIdent(tab))});
}

- (void)window:(ArdiaCoreWindow *)window didActivateTab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"tabActivated", @"window" : @(WindowIdent(window)), @"tab" : @(TabIdent(tab))});
}

- (void)window:(ArdiaCoreWindow *)window devToolsDidChangeForTab:(ArdiaCoreTab *)tab view:(NSView *)devToolsView {
  Emit(@{@"event" : @"devToolsChanged", @"window" : @(WindowIdent(window)), @"tab" : @(TabIdent(tab)), @"open" : @(devToolsView != nil)});
}

- (void)window:(ArdiaCoreWindow *)window tab:(ArdiaCoreTab *)tab didChangeFullscreen:(BOOL)fullscreen {
  Emit(@{@"event" : @"fullscreen", @"window" : @(WindowIdent(window)), @"tab" : @(TabIdent(tab)), @"fullscreen" : @(fullscreen)});
}

- (void)window:(ArdiaCoreWindow *)window passwordPrompt:(NSDictionary<NSString *, id> *)prompt forTab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"passwordPrompt", @"window" : @(WindowIdent(window)), @"tab" : @(TabIdent(tab)), @"prompt" : prompt ?: @{}});
}

- (void)window:(ArdiaCoreWindow *)window autofillPrompt:(NSDictionary<NSString *, id> *)prompt forTab:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"autofillPrompt", @"window" : @(WindowIdent(window)), @"tab" : @(TabIdent(tab)), @"prompt" : prompt ?: @{}});
}

- (void)window:(ArdiaCoreWindow *)window showRequestedActive:(BOOL)active {
  Emit(@{@"event" : @"showRequested", @"window" : @(WindowIdent(window)), @"active" : @(active)});
}

- (BOOL)windowShouldClose:(ArdiaCoreWindow *)window {
  return Decide(@{@"question" : @"windowShouldClose", @"window" : @(WindowIdent(window))}, true);
}

- (void)windowDidCancelClose:(ArdiaCoreWindow *)window {
  Emit(@{@"event" : @"closeCancelled", @"window" : @(WindowIdent(window))});
}

- (void)windowCanTakeTabs:(ArdiaCoreWindow *)window {
  Emit(@{@"event" : @"canTakeTabs", @"window" : @(WindowIdent(window))});
}

- (void)window:(ArdiaCoreWindow *)window confirmCloseWithDownloads:(int)count completion:(void (^)(BOOL))completion {
  if (!completion) return;
  if (!Listening()) return completion(YES);
  const uint64_t request = ++gNextConfirm;
  DownloadConfirms()[@(request)] = [completion copy];
  Emit(@{@"event" : @"confirmCloseWithDownloads", @"window" : @(WindowIdent(window)), @"count" : @(count), @"request" : @(request)});
}

- (BOOL)window:(ArdiaCoreWindow *)window preHandleKeyEvent:(NSEvent *)event {
  return Decide(WithKeyEvent(@{@"question" : @"preHandleKey", @"window" : @(WindowIdent(window))}, event), false);
}

- (BOOL)window:(ArdiaCoreWindow *)window handleKeyEvent:(NSEvent *)event {
  return Decide(WithKeyEvent(@{@"question" : @"handleKey", @"window" : @(WindowIdent(window))}, event), false);
}

@end

static void EmitTitle(ArdiaCoreTab *tab, NSString *event) {
  Emit(@{@"event" : event, @"tab" : @(TabIdent(tab)), @"title" : tab.title ?: @"", @"url" : tab.url ?: @"", @"loading" : @(tab.loading)});
}

@implementation ABTabDelegate

- (void)tabDidChangeTitle:(ArdiaCoreTab *)tab {
  EmitTitle(tab, @"title");
}

- (void)tabDidChangeURL:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"url", @"tab" : @(TabIdent(tab)), @"url" : tab.url ?: @""});
  EmitTitle(tab, @"shownTitle");
}

- (void)tabDidChangeLoading:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"loading", @"tab" : @(TabIdent(tab)), @"loading" : @(tab.loading)});
  EmitTitle(tab, @"shownTitle");
}

- (void)tabDidChangeProgress:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"progress", @"tab" : @(TabIdent(tab)), @"progress" : @(tab.progress)});
}

- (void)tabDidChangeFavicon:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"favicon", @"tab" : @(TabIdent(tab)), @"url" : tab.faviconURL ?: NSNull.null});
}

- (void)tabDidChangeNavigationState:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"navigationState", @"tab" : @(TabIdent(tab)), @"canGoBack" : @(tab.canGoBack), @"canGoForward" : @(tab.canGoForward)});
}

- (void)tab:(ArdiaCoreTab *)tab didFindMatches:(int)count active:(int)active final:(BOOL)final {
  Emit(@{@"event" : @"findMatches", @"tab" : @(TabIdent(tab)), @"count" : @(count), @"active" : @(active), @"final" : @(final)});
}

- (void)tab:(ArdiaCoreTab *)tab
    didReceivePageMessage:(NSString *)kind
                     json:(NSString *)json
                    frame:(NSString *)frameId
                     main:(BOOL)main
                   origin:(NSString *)origin {
  if ([kind isEqualToString:@"nowPlaying"]) ardia_pip::NoteMediaFrame(tab, frameId ?: @"", main);
  Emit(@{
    @"event" : @"pageMessage",
    @"tab" : @(TabIdent(tab)),
    @"kind" : kind ?: @"",
    @"json" : json ?: @"",
    @"frame" : frameId ?: @"",
    @"main" : @(main),
    @"origin" : origin.length ? origin : NSNull.null
  });
}

- (void)tabWillClose:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"willClose", @"tab" : @(TabIdent(tab))});
}

- (void)tab:(ArdiaCoreTab *)tab rendererGone:(NSString *)status code:(int)code {
  Emit(@{@"event" : @"rendererGone", @"tab" : @(TabIdent(tab)), @"status" : status ?: @"", @"code" : @(code)});
}

- (void)tab:(ArdiaCoreTab *)tab didFailLoad:(NSString *)url code:(int)code description:(NSString *)text {
  Emit(@{@"event" : @"failLoad", @"tab" : @(TabIdent(tab)), @"url" : url ?: @"", @"code" : @(code), @"description" : text ?: @""});
}

- (void)tab:(ArdiaCoreTab *)tab didChangeStatusText:(NSString *)text {
  Emit(@{@"event" : @"statusText", @"tab" : @(TabIdent(tab)), @"text" : text ?: @""});
}

- (void)tab:(ArdiaCoreTab *)tab didRequestAppURL:(NSString *)url userGesture:(BOOL)userGesture {
  Emit(@{@"event" : @"appUrl", @"tab" : @(TabIdent(tab)), @"url" : url ?: @"", @"userGesture" : @(userGesture)});
}

- (void)tabDidChangeThemeColor:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"themeColor", @"tab" : @(TabIdent(tab)), @"color" : tab.themeColor ?: NSNull.null});
}

- (void)tabDidCommitDocument:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"committed", @"tab" : @(TabIdent(tab))});
}

- (void)tabDidGainFocus:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"focus", @"tab" : @(TabIdent(tab))});
}

- (void)tabDidChangeAudio:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"audio", @"tab" : @(TabIdent(tab)), @"audible" : @(tab.audible), @"muted" : @(tab.muted)});
}

- (void)tabDidChangeSecurity:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"security", @"tab" : @(TabIdent(tab))});
}

- (void)tabDidChangeZoom:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"zoom", @"tab" : @(TabIdent(tab)), @"zoom" : @(tab.zoomFactor)});
}

- (void)tab:(ArdiaCoreTab *)tab didBlockPopup:(NSDictionary<NSString *, NSString *> *)popup {
  Emit(@{@"event" : @"popupBlocked", @"tab" : @(TabIdent(tab)), @"popup" : popup ?: @{}});
}

- (void)tab:(ArdiaCoreTab *)tab preferredSizeDidChange:(NSSize)size {
  Emit(@{@"event" : @"preferredSize", @"tab" : @(TabIdent(tab)), @"width" : @(size.width), @"height" : @(size.height)});
}

- (void)tab:(ArdiaCoreTab *)tab externalAppRequest:(NSDictionary<NSString *, id> *)request {
  Emit(@{@"event" : @"externalApp", @"tab" : @(TabIdent(tab)), @"request" : request ?: @{}});
}

- (void)tab:(ArdiaCoreTab *)tab requestsActivation:(NSString *)reason {
  BOOL fromOtherApp = NO;
  const BOOL backToTab = ardia_pip::TabRequestedActivationFor(tab, &fromOtherApp);
  Emit(@{@"event" : @"activation", @"tab" : @(TabIdent(tab)), @"reason" : backToTab ? @"pictureInPicture" : reason ?: @"", @"fromOtherApp" : @(backToTab && fromOtherApp)});
}

- (void)tab:(ArdiaCoreTab *)tab didChangePictureInPicture:(NSDictionary<NSString *, id> *)state {
  Emit(@{@"event" : @"pip", @"tab" : @(TabIdent(tab)), @"state" : state ?: @{}});
  ardia_pip::TabChangedPictureInPicture(tab, state ?: @{});
}

- (void)tab:(ArdiaCoreTab *)tab didShowAutofillSuggestions:(NSArray<NSDictionary<NSString *, NSString *> *> *)items {
  Emit(@{@"event" : @"autofillSuggestions", @"tab" : @(TabIdent(tab)), @"items" : items ?: @[]});
}

- (void)tab:(ArdiaCoreTab *)tab didBlockRequests:(int)count lastURL:(NSString *)url {
  Emit(@{@"event" : @"blockedRequests", @"tab" : @(TabIdent(tab)), @"count" : @(count), @"url" : url ?: @""});
}

- (NSArray<NSDictionary<NSString *, NSString *> *> *)tab:(ArdiaCoreTab *)tab contextMenuItemsForSelection:(NSString *)text {
  return MenuItems(Answer(@{@"question" : @"contextMenuItems", @"tab" : @(TabIdent(tab)), @"on" : @"selection", @"value" : text ?: @""}));
}

- (NSArray<NSDictionary<NSString *, NSString *> *> *)tab:(ArdiaCoreTab *)tab contextMenuItemsForPage:(NSString *)url {
  return MenuItems(Answer(@{@"question" : @"contextMenuItems", @"tab" : @(TabIdent(tab)), @"on" : @"page", @"value" : url ?: @""}));
}

- (void)tab:(ArdiaCoreTab *)tab
    contextMenuCommand:(NSString *)itemId
                  text:(NSString *)selection
             modifiers:(NSDictionary<NSString *, NSNumber *> *)modifiers {
  Emit(@{
    @"event" : @"contextMenuCommand",
    @"tab" : @(TabIdent(tab)),
    @"item" : itemId ?: @"",
    @"text" : selection ?: @"",
    @"modifiers" : modifiers ?: @{}
  });
}

- (void)tab:(ArdiaCoreTab *)tab shareFromContextMenu:(NSDictionary<NSString *, id> *)share {
  Emit(@{@"event" : @"shareFromContextMenu", @"tab" : @(TabIdent(tab)), @"share" : share ?: @{}});
}

- (void)tab:(ArdiaCoreTab *)tab didShowContextMenu:(NSArray<NSDictionary *> *)items {
  Emit(@{@"event" : @"contextMenuShown", @"tab" : @(TabIdent(tab)), @"items" : items ?: @[]});
}

- (NSDictionary<NSString *, id> *)tab:(ArdiaCoreTab *)tab runContextMenu:(NSDictionary<NSString *, id> *)menu {
  id answer = Answer(@{@"question" : @"runContextMenu", @"tab" : @(TabIdent(tab)), @"menu" : menu ?: @{}});
  return [answer isKindOfClass:NSDictionary.class] ? answer : nil;
}

- (void)tab:(ArdiaCoreTab *)tab navigationBecameDownload:(NSString *)url {
  Emit(@{@"event" : @"becameDownload", @"tab" : @(TabIdent(tab)), @"url" : url ?: @""});
}

- (void)tabDidChangeDiscarded:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"discarded", @"tab" : @(TabIdent(tab)), @"discarded" : @(tab.discarded), @"reason" : tab.discardReason ?: NSNull.null});
}

- (void)tabBecameUnresponsive:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"unresponsive", @"tab" : @(TabIdent(tab))});
}

- (void)tabBecameResponsive:(ArdiaCoreTab *)tab {
  Emit(@{@"event" : @"responsive", @"tab" : @(TabIdent(tab))});
}

- (void)tab:(ArdiaCoreTab *)tab didChangeMediaAccess:(NSDictionary<NSString *, NSNumber *> *)access {
  Emit(@{@"event" : @"mediaAccess", @"tab" : @(TabIdent(tab)), @"access" : access ?: @{}});
}

@end

@implementation ABScrollObserver

- (void)pageView:(NSView *)view ackedScroll:(ArdiaCorePageScrollAck)ack consumed:(BOOL)consumed {
  Emit(@{@"event" : @"scrollAck", @"view" : @((uint64_t)(uintptr_t)(__bridge void *)view), @"ack" : @((int)ack), @"consumed" : @(consumed)});
}

- (void)pageView:(NSView *)view overscrolledAllowingHorizontal:(BOOL)allowed {
  Emit(@{@"event" : @"overscroll", @"view" : @((uint64_t)(uintptr_t)(__bridge void *)view), @"allowed" : @(allowed)});
}

@end

namespace {

template <typename Body>
ArdiaBridgeStatus Guarded(Body body) {
  if (!NSThread.isMainThread) return ARDIA_BRIDGE_WRONG_THREAD;
  @autoreleasepool {
    @try {
      return body();
    } @catch (NSException *exception) {
      if ([exception.name isEqualToString:kBadArgument]) {
        NSLog(@"[ardia-engine] bad argument: %@", exception.reason);
        return ARDIA_BRIDGE_BAD_ARGUMENT;
      }
      NSLog(@"[ardia-engine] %@: %@", exception.name, exception.reason);
      return ARDIA_BRIDGE_FAILED;
    }
  }
}

typedef id (^EngineOp)(ArdiaCoreEngine *engine, NSDictionary *args);
typedef id (^ProfileOp)(ArdiaCoreEngine *engine, ArdiaCoreProfile *profile, NSDictionary *args);
typedef id (^WindowOp)(ArdiaCoreWindow *window, NSDictionary *args);
typedef id (^TabOp)(ArdiaCoreTab *tab, NSDictionary *args);

NSDictionary<NSString *, EngineOp> *EngineOps() {
  static NSDictionary *ops;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class E = EngineClass();
    ops = @{
      @"chromiumVersion" : ^id(ArdiaCoreEngine *engine, NSDictionary *) { return engine.chromiumVersion ?: @""; },
      @"keepAliveState" : ^id(ArdiaCoreEngine *engine, NSDictionary *) { return engine.keepAliveState ?: @""; },
      @"pictureInPictureCloses" : ^id(ArdiaCoreEngine *engine, NSDictionary *) { return engine.pictureInPictureCloses ?: @""; },
      @"videoUpscalingState" : ^id(ArdiaCoreEngine *, NSDictionary *) { return [E videoUpscalingState] ?: @{}; },
      @"desktopCaptureAudio" : ^id(ArdiaCoreEngine *, NSDictionary *) { return [E desktopCaptureAudio] ?: @{}; },
      @"pagesPickDisplayMedia" : ^id(ArdiaCoreEngine *, NSDictionary *) { return @([E pagesPickDisplayMedia]); },
      @"isTracing" : ^id(ArdiaCoreEngine *, NSDictionary *) { return @([E isTracing]); },
      @"testExternalLaunches" : ^id(ArdiaCoreEngine *, NSDictionary *) { return [E testExternalLaunches] ?: @[]; },
      @"testChooserEvents" : ^id(ArdiaCoreEngine *, NSDictionary *) { return [E testChooserEvents] ?: @[]; },
      @"quit" : ^id(ArdiaCoreEngine *engine, NSDictionary *) {
        [engine quit];
        return nil;
      },
      @"defaultProfile" : ^id(ArdiaCoreEngine *engine, NSDictionary *) { return @(HeldProfileIdent(engine.defaultProfile)); },
      @"resolvePermission" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E resolvePermission:Str(a, @"requestId") result:Str(a, @"result") remember:Flag(a, @"remember")];
        return nil;
      },
      @"resolveExtensionInstall" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E resolveExtensionInstallPrompt:Str(a, @"requestId") accepted:Flag(a, @"accepted")];
        return nil;
      },
      @"resolveExternalApp" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E resolveExternalApp:Str(a, @"requestId") open:Flag(a, @"open") remember:Flag(a, @"remember")];
        return nil;
      },
      @"selectDevice" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E selectDevice:Int(a, @"chooserId") index:Int(a, @"index")];
        return nil;
      },
      @"deviceChooserAction" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        NSString *action = Str(a, @"action");
        const int chooser = Int(a, @"chooserId");
        if ([action isEqualToString:@"cancel"]) [E cancelDeviceChooser:chooser];
        else if ([action isEqualToString:@"refresh"]) [E refreshDeviceChooser:chooser];
        else if ([action isEqualToString:@"settings"]) [E openDeviceChooserSettings:chooser];
        else Bad(@"unknown device chooser action");
        return nil;
      },
      @"startCasting" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E startCasting:Int(a, @"dialogId") sink:Str(a, @"sinkId") mode:Int(a, @"mode")];
        return nil;
      },
      @"stopCasting" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E stopCasting:Int(a, @"dialogId") route:Str(a, @"routeId")];
        return nil;
      },
      @"closeCastDialog" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E closeCastDialog:Int(a, @"dialogId")];
        return nil;
      },
      @"terminateCastRoute" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E terminateCastRoute:Str(a, @"routeId")];
        return nil;
      },
      @"allowDesktopCapture" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E allowDesktopCapture:Str(a, @"sourceId") tab:NeedTab(a, @"tab") frame:OptStr(a, @"frame") origin:OptStr(a, @"origin") audio:OptStr(a, @"audio")];
        return nil;
      },
      @"setPagesPickDisplayMedia" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E setPagesPickDisplayMedia:Flag(a, @"enabled")];
        return nil;
      },
      @"setAutoPictureInPicture" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E setAutoPictureInPicture:Flag(a, @"enabled")];
        return nil;
      },
      @"setVideoUpscaling" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        [E setVideoUpscaling:Flag(a, @"enabled")];
        return nil;
      },
      @"setVideoUpscalingTestConditions" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        NSMutableDictionary<NSString *, NSNumber *> *conditions = [NSMutableDictionary dictionary];
        id given = a[@"conditions"];
        if ([given isKindOfClass:NSDictionary.class])
          [(NSDictionary *)given enumerateKeysAndObjectsUsingBlock:^(id key, id value, BOOL *) {
            if ([key isKindOfClass:NSString.class] && [value isKindOfClass:NSNumber.class]) conditions[key] = value;
          }];
        [E setVideoUpscalingTestConditions:conditions];
        return nil;
      },
      @"reservedShortcutsChanged" : ^id(ArdiaCoreEngine *, NSDictionary *) {
        [E reservedShortcutsChanged];
        return nil;
      },
      @"resolveCloseWithDownloads" : ^id(ArdiaCoreEngine *, NSDictionary *a) {
        NSNumber *request = @(Ident(a, @"request"));
        void (^confirm)(BOOL) = DownloadConfirms()[request];
        [DownloadConfirms() removeObjectForKey:request];
        if (confirm) confirm(Flag(a, @"closeAnyway"));
        return @(confirm != nil);
      },
    };
  });
  return ops;
}

NSArray<ArdiaCoreTab *> *TabsNamed(NSArray *identifiers) {
  NSMutableArray<ArdiaCoreTab *> *tabs = [NSMutableArray array];
  for (id ident in identifiers) {
    int64_t whole = 0;
    if (!IntegerValue(ident, 1, INT64_MAX, &whole)) Bad(@"tabs must be tab ids");
    if (ArdiaCoreTab *tab = TabFor((uint64_t)whole)) [tabs addObject:tab];
  }
  return tabs;
}

NSDictionary *ProfileInfo(ArdiaCoreProfile *profile) {
  return @{
    @"name" : profile.name ?: @"",
    @"path" : profile.path ?: @"",
    @"offTheRecord" : @(profile.offTheRecord),
    @"destroyed" : @(profile.destroyed),
    @"passwordsOffered" : @(profile.passwordsOffered),
    @"addressesAutofilled" : @(profile.addressesAutofilled),
    @"cardsAutofilled" : @(profile.cardsAutofilled),
    @"preloadPages" : @(profile.preloadPages),
  };
}

NSDictionary<NSString *, ProfileOp> *ProfileOps() {
  static NSDictionary *ops;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    ops = @{
      @"info" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *) { return ProfileInfo(profile); },
      @"release" : ^id(ArdiaCoreEngine *engine, ArdiaCoreProfile *profile, NSDictionary *) {
        const uint64_t ident = ProfileIdent(profile);
        [engine releaseProfile:profile];
        [Profiles() drop:ident];
        return nil;
      },
      @"setFlag" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *a) {
        NSString *flag = Str(a, @"flag");
        const BOOL on = Flag(a, @"on");
        if ([flag isEqualToString:@"passwordsOffered"]) profile.passwordsOffered = on;
        else if ([flag isEqualToString:@"addressesAutofilled"]) profile.addressesAutofilled = on;
        else if ([flag isEqualToString:@"cardsAutofilled"]) profile.cardsAutofilled = on;
        else if ([flag isEqualToString:@"preloadPages"]) profile.preloadPages = on;
        else Bad(@"unknown profile flag");
        return nil;
      },
      @"loadComponentExtension" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *a) {
        return [profile loadComponentExtension:Str(a, @"path")];
      },
      @"unloadComponentExtension" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *a) {
        [profile unloadComponentExtension:Str(a, @"extensionId")];
        return nil;
      },
      @"warmSpareRenderer" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *) {
        [profile warmSpareRenderer];
        return nil;
      },
      @"holdNavigationsUntilRulesetsOf" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *a) {
        [profile holdNavigationsUntilRulesetsOf:Str(a, @"extensionId")];
        return nil;
      },
      @"releaseNavigationHold" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *a) {
        [profile releaseNavigationHold:Str(a, @"reason")];
        return nil;
      },
      @"releaseNavigationHoldReady" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *) {
        [profile releaseNavigationHoldReady];
        return nil;
      },
      @"watchCastRoutes" : ^id(ArdiaCoreEngine *, ArdiaCoreProfile *profile, NSDictionary *) {
        [profile watchCastRoutes];
        return nil;
      },
      @"sleepIdleProfile" : ^id(ArdiaCoreEngine *engine, ArdiaCoreProfile *profile, NSDictionary *a) {
        return [engine sleepIdleProfile:profile hostedTabs:TabsNamed(List(a, @"tabs"))];
      },
      @"unloadIdleProfile" : ^id(ArdiaCoreEngine *engine, ArdiaCoreProfile *profile, NSDictionary *) {
        return [engine unloadIdleProfile:profile] ?: @"";
      },
    };
  });
  return ops;
}

NSDictionary *RectDict(NSRect rect) {
  return @{@"x" : @(rect.origin.x), @"y" : @(rect.origin.y), @"width" : @(rect.size.width), @"height" : @(rect.size.height)};
}

NSDictionary *WindowInfo(ArdiaCoreWindow *window) {
  NSWindow *ns = window.window;
  return @{
    @"frame" : RectDict(ns ? ns.frame : NSZeroRect),
    @"activeProfile" : window.activeProfile ? @(ProfileIdent(window.activeProfile)) : NSNull.null,
    @"actedFullScreen" : @(window.actedFullScreen),
    @"internal" : @(window.internal),
    @"automation" : @(window.automation),
    @"visible" : @(ns.isVisible),
    @"windowNumber" : @(ns.windowNumber),
  };
}

NSDictionary<NSString *, WindowOp> *WindowOps() {
  static NSDictionary *ops;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    ops = @{
      @"info" : ^id(ArdiaCoreWindow *window, NSDictionary *) { return WindowInfo(window); },
      @"activateTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        [window activateTab:NeedTab(a, @"tab")];
        return nil;
      },
      @"placeTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        [window placeTab:NeedTab(a, @"tab") index:Int(a, @"index") pinned:Flag(a, @"pinned")];
        return nil;
      },
      @"setActiveProfile" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        window.activeProfile = Absent(a, @"profile") ? nil : NeedProfile(a, @"profile");
        return nil;
      },
      @"prepareProfile" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        [window prepareProfile:NeedProfile(a, @"profile")];
        return nil;
      },
      @"showInactive" : ^id(ArdiaCoreWindow *window, NSDictionary *) {
        [window showInactive];
        return nil;
      },
      @"setActedFullScreen" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        window.actedFullScreen = Flag(a, @"on");
        return nil;
      },
      @"setInternal" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        window.internal = Flag(a, @"on");
        return nil;
      },
      @"setAutomation" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        window.automation = Flag(a, @"on");
        return nil;
      },
      @"close" : ^id(ArdiaCoreWindow *window, NSDictionary *) {
        [window close];
        return nil;
      },
      @"openTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        return @(TabIdent([window openTab:Str(a, @"url") profile:NeedProfile(a, @"profile") foreground:Flag(a, @"foreground")]));
      },
      @"openExtensionView" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        ArdiaCoreTab *tab = [window openExtensionView:Str(a, @"url") profile:NeedProfile(a, @"profile") kind:Str(a, @"kind")];
        return tab ? @(TabIdent(tab)) : nil;
      },
      @"restoreTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        ArdiaCoreTab *tab = [window restoreTab:OptStr(a, @"state") profile:NeedProfile(a, @"profile") foreground:Flag(a, @"foreground")];
        return tab ? @(TabIdent(tab)) : nil;
      },
      @"duplicateTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        ArdiaCoreTab *tab = [window duplicateTab:NeedTab(a, @"source") profile:NeedProfile(a, @"profile") foreground:Flag(a, @"foreground")];
        return tab ? @(TabIdent(tab)) : nil;
      },
      @"adoptTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) { return @((NSInteger)[window adoptTab:NeedTab(a, @"tab")]); },
      @"canAdoptTab" : ^id(ArdiaCoreWindow *window, NSDictionary *a) { return @((NSInteger)[window canAdoptTab:NeedTab(a, @"tab")]); },
      @"tabsForProfile" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        NSMutableArray *ids = [NSMutableArray array];
        for (ArdiaCoreTab *tab in [window tabsForProfile:NeedProfile(a, @"profile")]) [ids addObject:@(TabIdent(tab))];
        return ids;
      },
      @"chromeWindowId" : ^id(ArdiaCoreWindow *window, NSDictionary *a) { return @([window chromeWindowIdForProfile:NeedProfile(a, @"profile")]); },
      @"executeChromeCommand" : ^id(ArdiaCoreWindow *window, NSDictionary *a) {
        return @([window executeChromeCommand:Int(a, @"command") profile:NeedProfile(a, @"profile")]);
      },
    };
  });
  return ops;
}

NSDictionary *TabInfo(ArdiaCoreTab *tab) {
  const NSSize preferred = tab.preferredSize;
  return @{
    @"tabId" : @(tab.tabId),
    @"browserId" : @(tab.browserId),
    @"profile" : tab.profile ? @(ProfileIdent(tab.profile)) : NSNull.null,
    @"url" : tab.url ?: @"",
    @"title" : tab.title ?: @"",
    @"loading" : @(tab.loading),
    @"progress" : @(tab.progress),
    @"canGoBack" : @(tab.canGoBack),
    @"canGoForward" : @(tab.canGoForward),
    @"closed" : @(tab.closed),
    @"audible" : @(tab.audible),
    @"muted" : @(tab.muted),
    @"discarded" : @(tab.discarded),
    @"discardReason" : tab.discardReason ?: NSNull.null,
    @"frozen" : @(tab.frozen),
    @"temporary" : @(tab.temporary),
    @"faviconUrl" : tab.faviconURL ?: NSNull.null,
    @"themeColor" : tab.themeColor ?: NSNull.null,
    @"committedOrigin" : tab.committedOrigin ?: NSNull.null,
    @"committedHttpStatus" : @(tab.committedHTTPStatus),
    @"committedDocumentCount" : @(tab.committedDocumentCount),
    @"initialDocumentAccessed" : @(tab.initialDocumentAccessed),
    @"committedInitial" : @(tab.committedInitial),
    @"asksBeforeLeaving" : @(tab.asksBeforeLeaving),
    @"zoomFactor" : @(tab.zoomFactor),
    @"pinchScale" : @(tab.pinchScale),
    @"preferredSize" : @{@"width" : @(preferred.width), @"height" : @(preferred.height)},
    @"mediaCaptureSourceId" : tab.mediaCaptureSourceId ?: NSNull.null,
    @"hasDevTools" : @(tab.devToolsView != nil),
  };
}

NSDictionary<NSString *, TabOp> *TabOps() {
  static NSDictionary *ops;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    ops = @{
      @"info" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return TabInfo(tab); },
      @"navigationEntries" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return tab.navigationEntries ?: @[]; },
      @"securityInfo" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return tab.securityInfo ?: @{}; },
      @"passwordPrompt" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return tab.passwordPrompt; },
      @"autofillPrompt" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return tab.autofillPrompt; },
      @"popupFeatures" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return tab.popupFeatures; },
      @"loadUrl" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab loadURL:Str(a, @"url") userInitiated:Flag(a, @"userInitiated")];
        return nil;
      },
      @"goBack" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab goBack];
        return nil;
      },
      @"goForward" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab goForward];
        return nil;
      },
      @"reload" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab reload];
        return nil;
      },
      @"reloadIgnoringCache" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab reloadIgnoringCache];
        return nil;
      },
      @"stop" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab stop];
        return nil;
      },
      @"goToOffset" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab goToOffset:Int(a, @"offset")];
        return nil;
      },
      @"loadIfNeeded" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab loadIfNeeded];
        return nil;
      },
      @"focus" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab focus];
        return nil;
      },
      @"close" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab close];
        return nil;
      },
      @"closeNow" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab closeNow];
        return nil;
      },
      @"find" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab find:Str(a, @"text") forward:Flag(a, @"forward")];
        return nil;
      },
      @"stopFinding" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab stopFinding];
        return nil;
      },
      @"setMuted" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.muted = Flag(a, @"muted");
        return nil;
      },
      @"setZoom" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.zoomFactor = Num(a, @"factor");
        return nil;
      },
      @"zoomStep" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab zoomStep:Int(a, @"direction")];
        return nil;
      },
      @"setFrozen" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.frozen = Flag(a, @"frozen");
        return nil;
      },
      @"resolveUnresponsive" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab resolveUnresponsive:Flag(a, @"terminate")];
        return nil;
      },
      @"showDevTools" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab showDevTools];
        return nil;
      },
      @"showDevToolsPanel" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab showDevToolsPanel:Str(a, @"panel")];
        return nil;
      },
      @"closeDevTools" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab closeDevTools];
        return nil;
      },
      @"executeJavaScript" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab executeJavaScript:Str(a, @"code") frame:OptStr(a, @"frame")];
        return nil;
      },
      @"callPage" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab callPage:Str(a, @"kind") json:Str(a, @"json")];
        return nil;
      },
      @"callFrame" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab callFrame:Str(a, @"frame") kind:Str(a, @"kind") json:Str(a, @"json")];
        return nil;
      },
      @"grantUserActivation" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab grantUserActivationToFrame:Str(a, @"frame")];
        return nil;
      },
      @"deliverHeldPageMessages" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab deliverHeldPageMessages];
        return nil;
      },
      @"exitPictureInPicture" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab exitPictureInPicture];
        return nil;
      },
      @"uncoverPage" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        for (NSView *view in tab.view.subviews.copy)
          if ([view isKindOfClass:ACPageCover.class]) [(ACPageCover *)view uncover:Flag(a, @"fade")];
        return nil;
      },
      @"exitFullscreen" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab exitFullscreen];
        return nil;
      },
      @"exitExclusiveAccess" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab exitExclusiveAccess];
        return nil;
      },
      @"openBlockedPopup" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab openBlockedPopup:Str(a, @"popupId") always:Flag(a, @"always")];
        return nil;
      },
      @"resolveAutofillPrompt" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab resolveAutofillPrompt:(NSInteger)Integer(a, @"promptId", NSIntegerMin, NSIntegerMax) action:Str(a, @"action")];
        return nil;
      },
      @"setPageBackgroundColor" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.pageBackgroundColor = ColorFrom(a[@"color"]);
        return nil;
      },
      @"setPageColor" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.pageColor = OptStr(a, @"color");
        return nil;
      },
      @"setContentsBackgroundColor" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.contentsBackgroundColor = ColorFrom(a[@"color"]);
        return nil;
      },
      @"noteShown" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        ardia_pip::NoteHostShown(tab, Flag(a, @"shown"));
        return nil;
      },
      @"noteInShownSlot" : ^id(ArdiaCoreTab *tab, NSDictionary *) {
        [tab noteInShownSlot];
        return nil;
      },
      @"setTemporary" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        tab.temporary = Flag(a, @"temporary");
        return nil;
      },
      @"setTemporarySource" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        [tab setTemporarySource:Absent(a, @"source") ? nil : NeedTab(a, @"source")];
        return nil;
      },
      @"discard" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return @([tab discard]); },
      @"unloadKeepingHistory" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return @([tab unloadKeepingHistory]); },
      @"showCastDialog" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return @([tab showCastDialog]); },
      @"showAutofillSuggestions" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return @([tab showAutofillSuggestions:Flag(a, @"passwords")]); },
      @"stopCapture" : ^id(ArdiaCoreTab *tab, NSDictionary *) { return @([tab stopCapture]); },
      @"hasLiveFrame" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return @([tab hasLiveFrame:Str(a, @"frame")]); },
      @"executeChromeCommand" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return @([tab executeChromeCommand:Int(a, @"command")]); },
      @"shareThisTabInsteadFor" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return @([tab shareThisTabInsteadFor:NeedTab(a, @"capturer")]); },
      @"sleepIfHidden" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return [tab sleepIfHiddenFor:Num(a, @"seconds")] ?: @[]; },
      @"executeExtensionAction" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return [tab executeExtensionAction:Str(a, @"extensionId")] ?: @"none"; },
      @"actionStates" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return [tab actionStatesForExtensions:Strings(a, @"ids")] ?: @{}; },
      @"sidePanelUrl" : ^id(ArdiaCoreTab *tab, NSDictionary *a) { return [tab sidePanelURLForExtension:Str(a, @"extensionId")]; },
      @"devToolsLayout" : ^id(ArdiaCoreTab *tab, NSDictionary *a) {
        NSRect devtools = NSZeroRect;
        NSRect page = NSZeroRect;
        [tab devToolsLayoutForSize:NSMakeSize(Num(a, @"width"), Num(a, @"height")) devTools:&devtools page:&page];
        return @{@"devTools" : RectDict(devtools), @"page" : RectDict(page)};
      },
    };
  });
  return ops;
}

template <typename Op>
Op LookUp(NSDictionary *ops, NSDictionary *args) {
  NSString *name = OptStr(args, @"op");
  Op op = name ? ops[name] : nil;
  if (!op) Bad([NSString stringWithFormat:@"unknown operation %@", name ?: @"(none)"]);
  return op;
}

}

void ACPiPEmit(NSDictionary *event) {
  Emit(event);
}

uint64_t ACPiPTabIdent(ArdiaCoreTab *tab) {
  return TabIdent(tab);
}

extern "C" ArdiaBridgeStatus ardia_bridge_install(const ArdiaBridgeHost *host) {
  if (!NSThread.isMainThread) return ARDIA_BRIDGE_WRONG_THREAD;
  if (!host || host->size < sizeof(ArdiaBridgeHost) || !host->event || !host->decide || !host->new_window || !host->answer ||
      !host->release_answer || !host->complete)
    return ARDIA_BRIDGE_BAD_ARGUMENT;
  if (Hosted()) return memcmp(&gHost, host, sizeof(ArdiaBridgeHost)) == 0 ? ARDIA_BRIDGE_OK : ARDIA_BRIDGE_ALREADY_RUNNING;
  gHost = *host;
  gHostInstalled.store(true, std::memory_order_release);
  return ARDIA_BRIDGE_OK;
}

extern "C" bool ardia_bridge_is_main_thread(void) {
  return NSThread.isMainThread;
}

namespace {

NSString *RealPathOf(const char *path) {
  if (!path) return nil;
  char resolved[PATH_MAX];
  return @(realpath(path, resolved) ? resolved : path);
}

}

extern "C" char *ardia_bridge_check_classes(const char *image) {
  @autoreleasepool {
    NSString *expected = RealPathOf(image);
    NSMutableArray<NSString *> *missing = [NSMutableArray array];
    NSMutableArray<NSString *> *foreign = [NSMutableArray array];
    for (NSString *name in @[ @"ArdiaCoreEngine", @"ArdiaCoreProfile", @"ArdiaCoreWindow", @"ArdiaCoreTab", @"ArdiaCorePageView" ]) {
      Class cls = NSClassFromString(name);
      if (!cls) {
        [missing addObject:name];
      } else if (expected && ![RealPathOf(class_getImageName(cls)) isEqualToString:expected]) {
        [foreign addObject:name];
      }
    }
    return Copy(JSONText(@{@"missing" : missing, @"foreign" : foreign}));
  }
}

extern "C" bool ardia_bridge_engine_started(void) {
  return gStarted && SharedEngine() != nil;
}

extern "C" ArdiaBridgeStatus ardia_bridge_release_confirms(bool close_anyway, uint64_t *released) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    const NSUInteger count = ReleaseConfirms(close_anyway);
    if (released) *released = count;
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_run(int32_t argc, const char *const *argv, int32_t *exit_code) {
  if (!NSThread.isMainThread) return ARDIA_BRIDGE_WRONG_THREAD;
  if (!Hosted()) return ARDIA_BRIDGE_NO_HOST;
  if (argc < 1 || !argv) return ARDIA_BRIDGE_BAD_ARGUMENT;
  Class engine = EngineClass();
  if (!engine) return ARDIA_BRIDGE_NOT_LOADED;
  if (gRunning) return ARDIA_BRIDGE_ALREADY_RUNNING;
  gRunning = true;
  @try {
    const int code = [engine runWithArgc:argc argv:(const char **)argv delegate:EngineDelegate()];
    if (exit_code) *exit_code = code;
  } @catch (NSException *exception) {
    NSLog(@"[ardia-engine] the engine threw at run: %@", exception.reason);
    gRunning = false;
    gStarted = false;
    return ARDIA_BRIDGE_FAILED;
  }
  gRunning = false;
  gStarted = false;
  return ARDIA_BRIDGE_OK;
}

extern "C" ArdiaBridgeStatus ardia_bridge_engine_call(const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *args = Parse(json);
    NSString *op = OptStr(args, @"op");
    if ([op isEqualToString:@"setPageScript"]) {
      gPageScript = [OptStr(args, @"script") copy];
      gPageScriptPending = true;
      if (gStarted) ApplyPageScript();
      SetOut(out_json, nil);
      return ARDIA_BRIDGE_OK;
    }
    if (!EngineClass()) return ARDIA_BRIDGE_NOT_LOADED;
    ArdiaCoreEngine *engine = SharedEngine();
    if (!gStarted || !engine) return ARDIA_BRIDGE_NOT_STARTED;
    SetOut(out_json, LookUp<EngineOp>(EngineOps(), args)(engine, args));
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_engine_async(const char *json, uint64_t request) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *args = Parse(json);
    NSString *op = OptStr(args, @"op");
    if (!EngineClass()) return ARDIA_BRIDGE_NOT_LOADED;
    ArdiaCoreEngine *engine = SharedEngine();
    if (!gStarted || !engine) return ARDIA_BRIDGE_NOT_STARTED;
    ABCompletion *done = [[ABCompletion alloc] initWithRequest:request];
    if ([op isEqualToString:@"loadProfile"]) {
      [engine loadProfile:Str(args, @"directory")
               completion:^(ArdiaCoreProfile *profile) {
                 if (profile) [done finish:@{@"profile" : @(HeldProfileIdent(profile))}];
                 else [done fail:@"the profile didn't load"];
               }];
    } else if ([op isEqualToString:@"beginTracing"]) {
      [EngineClass() beginTracing:^(BOOL started) { [done finish:@{@"started" : @(started)}]; }];
    } else if ([op isEqualToString:@"endTracing"]) {
      [EngineClass() endTracing:Flag(args, @"keep")
                     completion:^(NSString *path) { [done finish:@{@"path" : path ?: NSNull.null}]; }];
    } else {
      Bad(@"unknown engine request");
    }
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_profile_call(uint64_t profileId, const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *args = Parse(json);
    ArdiaCoreEngine *engine = SharedEngine();
    if (!gStarted || !engine) return ARDIA_BRIDGE_NOT_STARTED;
    ArdiaCoreProfile *profile = ProfileFor(profileId);
    if (!profile) return ARDIA_BRIDGE_UNKNOWN_PROFILE;
    SetOut(out_json, LookUp<ProfileOp>(ProfileOps(), args)(engine, profile, args));
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_profile_async(uint64_t profileId, const char *json, uint64_t request) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *args = Parse(json);
    NSString *op = OptStr(args, @"op");
    ArdiaCoreEngine *engine = SharedEngine();
    if (!gStarted || !engine) return ARDIA_BRIDGE_NOT_STARTED;
    ArdiaCoreProfile *profile = ProfileFor(profileId);
    if (!profile) return ARDIA_BRIDGE_UNKNOWN_PROFILE;
    ABCompletion *done = [[ABCompletion alloc] initWithRequest:request];
    if ([op isEqualToString:@"offTheRecord"]) {
      [engine offTheRecordProfileFor:profile
                          completion:^(ArdiaCoreProfile *offTheRecord, NSString *error) {
                            if (offTheRecord) [done finish:@{@"profile" : @(HeldProfileIdent(offTheRecord))}];
                            else [done fail:error ?: @"the private profile didn't open"];
                          }];
    } else if ([op isEqualToString:@"delete"]) {
      [engine deleteProfile:profile
                 completion:^(BOOL deleted) {
                   if (deleted) [Profiles() drop:profileId];
                   [done finish:@{@"deleted" : @(deleted)}];
                 }];
    } else if ([op isEqualToString:@"clearBrowsingData"]) {
      id since = args[@"sinceMs"];
      NSDate *date = [since isKindOfClass:NSNumber.class] ? [NSDate dateWithTimeIntervalSince1970:[since doubleValue] / 1000] : nil;
      [profile clearBrowsingData:Strings(args, @"types")
                           since:date
                      completion:^{ [done finish:@{}]; }];
    } else if ([op isEqualToString:@"fetchIcon"]) {
      const int64_t maxBytes = Integer(args, @"maxBytes", 0, 1LL << 40);
      [profile fetchIcon:Str(args, @"url")
                maxBytes:(NSUInteger)maxBytes
              completion:^(NSData *body) { [done finishBytes:body]; }];
    } else {
      Bad(@"unknown profile request");
    }
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_window_create(double x, double y, double width, double height, uint64_t *out_window) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) || width < 0 || height < 0)
      return ARDIA_BRIDGE_BAD_ARGUMENT;
    if (!WindowClass()) return ARDIA_BRIDGE_NOT_LOADED;
    if (!gStarted || !SharedEngine()) return ARDIA_BRIDGE_NOT_STARTED;
    ArdiaCoreWindow *window = MakeWindow(NSMakeRect(x, y, width, height));
    if (!window) return ARDIA_BRIDGE_FAILED;
    if (out_window) *out_window = WindowIdent(window);
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_window_call(uint64_t windowId, const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!gStarted) return ARDIA_BRIDGE_NOT_STARTED;
    NSDictionary *args = Parse(json);
    ArdiaCoreWindow *window = [Windows() objectFor:windowId];
    if (!window || !window.window) return ARDIA_BRIDGE_UNKNOWN_WINDOW;
    SetOut(out_json, LookUp<WindowOp>(WindowOps(), args)(window, args));
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_window_object(uint64_t windowId, uint32_t which, void **out_object) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!out_object) return ARDIA_BRIDGE_BAD_ARGUMENT;
    *out_object = nullptr;
    if (!gStarted) return ARDIA_BRIDGE_NOT_STARTED;
    ArdiaCoreWindow *window = [Windows() objectFor:windowId];
    if (!window || !window.window) return ARDIA_BRIDGE_UNKNOWN_WINDOW;
    id object = which == 0 ? (id)window.window : which == 1 ? (id)window.hostView : nil;
    if (!object) return ARDIA_BRIDGE_BAD_ARGUMENT;
    *out_object = (__bridge_retained void *)object;
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_tab_call(uint64_t tabId, const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!gStarted) return ARDIA_BRIDGE_NOT_STARTED;
    NSDictionary *args = Parse(json);
    ArdiaCoreTab *tab = TabFor(tabId);
    if (!tab) return ARDIA_BRIDGE_UNKNOWN_TAB;
    SetOut(out_json, LookUp<TabOp>(TabOps(), args)(tab, args));
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_tab_async(uint64_t tabId, const char *json, uint64_t request) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!gStarted) return ARDIA_BRIDGE_NOT_STARTED;
    NSDictionary *args = Parse(json);
    NSString *op = OptStr(args, @"op");
    ArdiaCoreTab *tab = TabFor(tabId);
    if (!tab) return ARDIA_BRIDGE_UNKNOWN_TAB;
    ABCompletion *done = [[ABCompletion alloc] initWithRequest:request];
    if ([op isEqualToString:@"evaluate"]) {
      [tab evaluate:Str(args, @"code") completion:^(NSString *result) { [done finish:@{@"json" : result ?: NSNull.null}]; }];
    } else if ([op isEqualToString:@"coverPage"]) {
      [ACPageCover coverTab:tab then:^(BOOL covered) { [done finish:@{@"covered" : @(covered)}]; }];
    } else if ([op isEqualToString:@"askBeforeLeaving"]) {
      [tab askBeforeLeaving:^(BOOL leave) { [done finish:@{@"leave" : @(leave)}]; }];
    } else if ([op isEqualToString:@"enterPip"]) {
      [tab enterPictureInPictureForClickAt:Num(args, @"clickTime")
                                completion:^(NSString *route, BOOL opened) { [done finish:@{@"route" : route ?: @"", @"opened" : @(opened)}]; }];
    } else if ([op isEqualToString:@"devToolsCall"]) {
      id params = args[@"params"];
      const double timeout = Num(args, @"timeoutSeconds");
      if (timeout <= 0) Bad(@"timeoutSeconds must be positive");
      [tab devToolsCall:Str(args, @"method")
                 params:[params isKindOfClass:NSDictionary.class] ? params : nil
                timeout:timeout
             completion:^(NSDictionary *result, NSString *error) {
               if (error.length) [done fail:error];
               else [done finish:@{@"result" : result ?: NSNull.null}];
             }];
    } else {
      Bad(@"unknown tab request");
    }
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_tab_view(uint64_t tabId, uint32_t which, void **out_view) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!out_view) return ARDIA_BRIDGE_BAD_ARGUMENT;
    *out_view = nullptr;
    if (!gStarted) return ARDIA_BRIDGE_NOT_STARTED;
    ArdiaCoreTab *tab = TabFor(tabId);
    if (!tab) return ARDIA_BRIDGE_UNKNOWN_TAB;
    NSView *view = which == 0 ? tab.view : which == 1 ? tab.devToolsView : nil;
    if (!view) return ARDIA_BRIDGE_OK;
    view.hidden = NO;
    *out_view = (__bridge_retained void *)view;
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_tab_password(uint64_t tabId, const char *action, const char *username, const uint8_t *password,
                                                       size_t length) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!gStarted) return ARDIA_BRIDGE_NOT_STARTED;
    NSString *verb = Text(action);
    if (!verb.length) return ARDIA_BRIDGE_BAD_ARGUMENT;
    ArdiaCoreTab *tab = TabFor(tabId);
    if (!tab) return ARDIA_BRIDGE_UNKNOWN_TAB;
    NSString *secret = password ? [[NSString alloc] initWithBytes:password length:length encoding:NSUTF8StringEncoding] : nil;
    if (password && !secret) return ARDIA_BRIDGE_BAD_ARGUMENT;
    [tab resolvePasswordPrompt:verb username:Text(username) password:secret];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_page_view(void *view, uint32_t query, bool *out_answer) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!out_answer) return ARDIA_BRIDGE_BAD_ARGUMENT;
    *out_answer = false;
    Class pageView = PageViewClass();
    if (!pageView) return ARDIA_BRIDGE_NOT_LOADED;
    if (!view) return ARDIA_BRIDGE_OK;
    NSView *target = (__bridge NSView *)view;
    if (![target isKindOfClass:NSView.class]) return ARDIA_BRIDGE_BAD_ARGUMENT;
    switch (query) {
      case 0:
        *out_answer = [pageView isPageView:target];
        break;
      case 1:
        *out_answer = [pageView takeSwipes:target];
        break;
      case 2:
        *out_answer = [pageView takesSwipes:target];
        break;
      case 3:
        *out_answer = [pageView isEditingText:target];
        break;
      default:
        return ARDIA_BRIDGE_BAD_ARGUMENT;
    }
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_set_scroll_observer(bool enabled) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    gScrollObserverWanted = enabled;
    Class pageView = PageViewClass();
    if (pageView && gStarted) [pageView setScrollObserver:enabled ? ScrollObserver() : nil];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" void ardia_bridge_retain(void *object) {
  if (object) CFRetain(object);
}

extern "C" void ardia_bridge_release(void *object) {
  if (!object) return;
  if (NSThread.isMainThread) return CFRelease(object);
  dispatch_async(dispatch_get_main_queue(), ^{
    CFRelease(object);
  });
}

extern "C" void ardia_bridge_free(char *text) {
  free(text);
}

namespace guard {

constexpr NSWindowLevel kLevelBand = 1000000;
NSWindowLevel (*gLevel)(id, SEL) = nullptr;
void (*gSetLevel)(id, SEL, NSWindowLevel) = nullptr;
const void *const kAskedLevelKey = &kAskedLevelKey;
bool gSettingLevel = false;

bool Owns(Class cls, SEL selector) {
  unsigned int count = 0;
  Method *methods = class_copyMethodList(cls, &count);
  bool owns = false;
  for (unsigned int i = 0; i < count && !owns; i++) owns = method_getName(methods[i]) == selector;
  free(methods);
  return owns;
}

IMP Replace(Class cls, SEL selector, id block) {
  Method method = class_getInstanceMethod(cls, selector);
  if (!method) {
    NSLog(@"[ardia-engine] background guard: %@ has no %@", NSStringFromClass(cls), NSStringFromSelector(selector));
    return nullptr;
  }
  IMP original = method_getImplementation(method);
  IMP replacement = imp_implementationWithBlock(block);
  if (Owns(cls, selector)) method_setImplementation(method, replacement);
  else class_addMethod(cls, selector, replacement, method_getTypeEncoding(method));
  return original;
}

NSWindowLevel Lowered(NSWindowLevel level) {
  return level < 0 ? level : level < kLevelBand ? level - kLevelBand : -1;
}

void KeepLowered(NSWindow *window) {
  if (gLevel && gLevel(window, @selector(level)) >= 0) window.level = window.level;
}

NSModalResponse AnswerAlert(NSAlert *alert, NSString *how) {
  NSArray<NSButton *> *buttons = alert.buttons;
  NSUInteger pick = 0;
  for (NSUInteger i = 0; i < buttons.count; i++)
    if ([buttons[i].keyEquivalent isEqualToString:@"\e"]) pick = i;
  NSLog(@"[ardia-engine] background: alert not shown (%@): %@ | chose %@", how, alert.messageText, buttons.count ? buttons[pick].title : @"OK");
  return NSAlertFirstButtonReturn + (NSModalResponse)pick;
}

void InstallWindowLevels() {
  Class window = NSWindow.class;
  gLevel = (NSWindowLevel (*)(id, SEL))method_getImplementation(class_getInstanceMethod(window, @selector(level)));
  gSetLevel = (void (*)(id, SEL, NSWindowLevel))method_getImplementation(class_getInstanceMethod(window, @selector(setLevel:)));
  Replace(window, @selector(setLevel:), ^(NSWindow *self_, NSWindowLevel level) {
    const NSWindowLevel real = Lowered(level);
    objc_setAssociatedObject(self_, kAskedLevelKey, real != level ? @(level) : nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    const bool setting = gSettingLevel;
    gSettingLevel = true;
    gSetLevel(self_, @selector(setLevel:), real);
    gSettingLevel = setting;
  });
  Replace(window, @selector(level), ^NSWindowLevel(NSWindow *self_) {
    NSNumber *asked = gSettingLevel ? nil : objc_getAssociatedObject(self_, kAskedLevelKey);
    return asked ? asked.integerValue : gLevel(self_, @selector(level));
  });
  {
    SEL selector = @selector(initWithContentRect:styleMask:backing:defer:);
    __block IMP original = nullptr;
    original = Replace(window, selector, ^id(NSWindow *self_, NSRect rect, NSWindowStyleMask style, NSBackingStoreType backing, BOOL defer) {
      NSWindow *made = ((id (*)(id, SEL, NSRect, NSWindowStyleMask, NSBackingStoreType, BOOL))original)(self_, selector, rect, style, backing, defer);
      if (made) KeepLowered(made);
      return made;
    });
  }
  {
    SEL selector = @selector(initWithContentRect:styleMask:backing:defer:screen:);
    __block IMP original = nullptr;
    original = Replace(window, selector,
                       ^id(NSWindow *self_, NSRect rect, NSWindowStyleMask style, NSBackingStoreType backing, BOOL defer, NSScreen *screen) {
                         NSWindow *made = ((id (*)(id, SEL, NSRect, NSWindowStyleMask, NSBackingStoreType, BOOL, NSScreen *))original)(
                             self_, selector, rect, style, backing, defer, screen);
                         if (made) KeepLowered(made);
                         return made;
                       });
  }
  {
    SEL selector = @selector(orderWindow:relativeTo:);
    __block IMP original = nullptr;
    original = Replace(window, selector, ^(NSWindow *self_, NSWindowOrderingMode place, NSInteger other) {
      if (place != NSWindowOut) KeepLowered(self_);
      ((void (*)(id, SEL, NSWindowOrderingMode, NSInteger))original)(self_, selector, place, other);
    });
  }
  {
    SEL selector = @selector(orderFrontRegardless);
    __block IMP original = nullptr;
    original = Replace(window, selector, ^(NSWindow *self_) {
      KeepLowered(self_);
      ((void (*)(id, SEL))original)(self_, selector);
    });
  }
  {
    SEL selector = @selector(makeKeyAndOrderFront:);
    __block IMP original = nullptr;
    original = Replace(window, selector, ^(NSWindow *self_, id sender) {
      KeepLowered(self_);
      ((void (*)(id, SEL, id))original)(self_, selector, sender);
    });
  }
}

void InstallActivation() {
  Class app = NSApplication.class;
  {
    SEL selector = @selector(setActivationPolicy:);
    __block IMP original = nullptr;
    original = Replace(app, selector, ^BOOL(NSApplication *self_, NSApplicationActivationPolicy policy) {
      if (policy != NSApplicationActivationPolicyProhibited) NSLog(@"[ardia-engine] background: kept the app prohibited from activating");
      return ((BOOL (*)(id, SEL, NSApplicationActivationPolicy))original)(self_, selector, NSApplicationActivationPolicyProhibited);
    });
  }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  Replace(app, @selector(activateIgnoringOtherApps:), ^(NSApplication *, BOOL) {
    NSLog(@"[ardia-engine] background: blocked activateIgnoringOtherApps:");
  });
#pragma clang diagnostic pop
  if ([app instancesRespondToSelector:@selector(activate)])
    Replace(app, @selector(activate), ^(NSApplication *) {
      NSLog(@"[ardia-engine] background: blocked activate");
    });
  Replace(app, @selector(unhide:), ^(NSApplication *self_, id) {
    [self_ unhideWithoutActivation];
  });
  {
    SEL selector = @selector(activateWithOptions:);
    __block IMP original = nullptr;
    original = Replace(NSRunningApplication.class, selector, ^BOOL(NSRunningApplication *self_, NSApplicationActivationOptions options) {
      if ([self_ isEqual:NSRunningApplication.currentApplication]) {
        NSLog(@"[ardia-engine] background: blocked activateWithOptions:");
        return NO;
      }
      return ((BOOL (*)(id, SEL, NSApplicationActivationOptions))original)(self_, selector, options);
    });
  }
  [NSNotificationCenter.defaultCenter addObserverForName:NSApplicationDidBecomeActiveNotification
                                                  object:nil
                                                   queue:nil
                                              usingBlock:^(NSNotification *) {
                                                if (NSRunningApplication.currentApplication.isActive) [NSApp deactivate];
                                              }];
}

void InstallModals() {
  Replace(NSAlert.class, @selector(runModal), ^NSModalResponse(NSAlert *alert) { return AnswerAlert(alert, @"app-modal"); });
  Replace(NSAlert.class, @selector(beginSheetModalForWindow:completionHandler:), ^(NSAlert *alert, NSWindow *, void (^handler)(NSModalResponse)) {
    const NSModalResponse response = AnswerAlert(alert, @"sheet");
    if (handler) dispatch_async(dispatch_get_main_queue(), ^{ handler(response); });
  });
  for (Class panel : {(Class)NSOpenPanel.class, (Class)NSSavePanel.class}) {
    Replace(panel, @selector(runModal), ^NSModalResponse(NSSavePanel *) {
      NSLog(@"[ardia-engine] background: file panel not shown, cancelled");
      return NSModalResponseCancel;
    });
    Replace(panel, @selector(beginWithCompletionHandler:), ^(NSSavePanel *, void (^handler)(NSModalResponse)) {
      NSLog(@"[ardia-engine] background: file panel not shown, cancelled");
      if (handler) dispatch_async(dispatch_get_main_queue(), ^{ handler(NSModalResponseCancel); });
    });
    Replace(panel, @selector(beginSheetModalForWindow:completionHandler:), ^(NSSavePanel *, NSWindow *, void (^handler)(NSModalResponse)) {
      NSLog(@"[ardia-engine] background: file panel sheet not shown, cancelled");
      if (handler) dispatch_async(dispatch_get_main_queue(), ^{ handler(NSModalResponseCancel); });
    });
  }
  Class menuMeta = object_getClass(NSMenu.class);
  Replace(menuMeta, @selector(popUpContextMenu:withEvent:forView:), ^(id, NSMenu *menu, NSEvent *, NSView *) {
    NSLog(@"[ardia-engine] background: context menu not shown (%ld items)", (long)menu.numberOfItems);
  });
  Replace(menuMeta, @selector(popUpContextMenu:withEvent:forView:withFont:), ^(id, NSMenu *menu, NSEvent *, NSView *, NSFont *) {
    NSLog(@"[ardia-engine] background: context menu not shown (%ld items)", (long)menu.numberOfItems);
  });
  Replace(NSMenu.class, @selector(popUpMenuPositioningItem:atLocation:inView:), ^BOOL(NSMenu *menu, NSMenuItem *, NSPoint, NSView *) {
    NSLog(@"[ardia-engine] background: pop-up menu not shown (%ld items)", (long)menu.numberOfItems);
    return NO;
  });
}

}

extern "C" ArdiaBridgeStatus ardia_bridge_install_background_guard(void) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    bool expected = false;
    if (!gGuardInstalled.compare_exchange_strong(expected, true)) return ARDIA_BRIDGE_OK;
    guard::InstallWindowLevels();
    guard::InstallActivation();
    guard::InstallModals();
    if (NSApp) [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" bool ardia_bridge_background_guard_installed(void) {
  return gGuardInstalled.load();
}

extern "C" ArdiaBridgeStatus ardia_bridge_window_levels(void *window, int64_t *asked, int64_t *actual) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSWindow *target = (__bridge NSWindow *)window;
    if (!target || !asked || !actual) return ARDIA_BRIDGE_BAD_ARGUMENT;
    *asked = target.level;
    *actual = guard::gLevel ? guard::gLevel(target, @selector(level)) : target.level;
    return ARDIA_BRIDGE_OK;
  });
}

@interface ABMenuTarget : NSObject <NSMenuItemValidation>
- (void)perform:(NSMenuItem *)item;
@end

@implementation ABMenuTarget

- (void)perform:(NSMenuItem *)item {
  NSDictionary *command = [item.representedObject isKindOfClass:NSDictionary.class] ? item.representedObject : nil;
  if (!command) return;
  Emit(@{@"event" : @"menuCommand", @"command" : command[@"command"] ?: @"", @"arg" : command[@"arg"] ?: NSNull.null});
}

- (BOOL)validateMenuItem:(NSMenuItem *)item {
  NSDictionary *command = [item.representedObject isKindOfClass:NSDictionary.class] ? item.representedObject : nil;
  if (!command || [command[@"enabled"] isEqual:@NO]) return NO;
  return Decide(@{@"question" : @"validateMenuItem", @"command" : command[@"command"] ?: @"", @"arg" : command[@"arg"] ?: NSNull.null}, true);
}

@end

namespace {

ABMenuTarget *MenuTarget() {
  static ABMenuTarget *target = [ABMenuTarget new];
  return target;
}

struct MenuRoles {
  NSMenu *services = nil;
  NSMenu *windows = nil;
  NSMenu *help = nil;
};

void ApplyShortcut(NSMenuItem *item, NSDictionary *spec) {
  NSString *key = OptStr(spec, @"key");
  if (!key.length) return;
  item.keyEquivalent = key;
  item.keyEquivalentModifierMask = (NSEventModifierFlags)OptNum(spec, @"modifiers", 0) & NSEventModifierFlagDeviceIndependentFlagsMask;
}

NSMenu *BuildMenu(NSDictionary *spec, MenuRoles &roles);

NSMenuItem *BuildItem(NSDictionary *spec, MenuRoles &roles) {
  NSString *kind = OptStr(spec, @"kind") ?: @"command";
  if ([kind isEqualToString:@"separator"]) return NSMenuItem.separatorItem;
  NSString *title = OptStr(spec, @"title") ?: @"";
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:nil keyEquivalent:@""];
  if ([kind isEqualToString:@"submenu"]) {
    item.submenu = BuildMenu(spec, roles);
    item.hidden = Flag(spec, @"hidden");
    return item;
  } else if ([kind isEqualToString:@"standard"]) {
    NSString *action = Str(spec, @"action");
    item.action = NSSelectorFromString(action);
    if ([OptStr(spec, @"target") isEqualToString:@"app"]) item.target = NSApp;
  } else if ([kind isEqualToString:@"command"]) {
    item.action = @selector(perform:);
    item.target = MenuTarget();
    NSString *command = Str(spec, @"command");
    item.representedObject = @{@"command" : command, @"arg" : OptStr(spec, @"arg") ?: NSNull.null, @"enabled" : @(![spec[@"enabled"] isEqual:@NO])};
    item.state = Flag(spec, @"checked") ? NSControlStateValueOn : NSControlStateValueOff;
  } else {
    Bad([NSString stringWithFormat:@"unknown menu item kind %@", kind]);
  }
  ApplyShortcut(item, spec);
  item.hidden = Flag(spec, @"hidden");
  item.alternate = Flag(spec, @"alternate");
  return item;
}

NSMenu *BuildMenu(NSDictionary *spec, MenuRoles &roles) {
  NSMenu *menu = [[NSMenu alloc] initWithTitle:OptStr(spec, @"title") ?: @""];
  menu.autoenablesItems = YES;
  for (id item in List(spec, @"items"))
    if ([item isKindOfClass:NSDictionary.class]) [menu addItem:BuildItem(item, roles)];
  NSString *role = OptStr(spec, @"role");
  if ([role isEqualToString:@"services"]) roles.services = menu;
  else if ([role isEqualToString:@"windows"]) roles.windows = menu;
  else if ([role isEqualToString:@"help"]) roles.help = menu;
  return menu;
}

NSMenu *BuildMenuBar(NSDictionary *spec, MenuRoles &roles) {
  NSMenu *bar = [[NSMenu alloc] initWithTitle:@"Main Menu"];
  for (id menuSpec in List(spec, @"menus")) {
    if (![menuSpec isKindOfClass:NSDictionary.class]) continue;
    NSMenuItem *root = [[NSMenuItem alloc] initWithTitle:OptStr(menuSpec, @"title") ?: @"" action:nil keyEquivalent:@""];
    root.submenu = BuildMenu(menuSpec, roles);
    [bar addItem:root];
  }
  return bar;
}

NSDictionary *DescribeItem(NSMenuItem *item);

NSArray *DescribeMenu(NSMenu *menu) {
  NSMutableArray *items = [NSMutableArray array];
  for (NSMenuItem *item in menu.itemArray) [items addObject:DescribeItem(item)];
  return items;
}

NSDictionary *DescribeItem(NSMenuItem *item) {
  if (item.isSeparatorItem) return @{@"kind" : @"separator"};
  NSMutableDictionary *described = [@{
    @"title" : item.title ?: @"",
    @"key" : item.keyEquivalent ?: @"",
    @"modifiers" : @(item.keyEquivalent.length ? item.keyEquivalentModifierMask : 0),
    @"hidden" : @(item.hidden),
    @"alternate" : @(item.alternate),
    @"checked" : @(item.state == NSControlStateValueOn),
    @"action" : item.action ? NSStringFromSelector(item.action) : NSNull.null,
  } mutableCopy];
  if (NSDictionary *command = [item.representedObject isKindOfClass:NSDictionary.class] ? item.representedObject : nil) {
    described[@"command"] = command[@"command"];
    described[@"arg"] = command[@"arg"];
    described[@"enabled"] = command[@"enabled"];
  }
  if (item.submenu) {
    described[@"kind"] = @"submenu";
    described[@"items"] = DescribeMenu(item.submenu);
  } else {
    described[@"kind"] = item.target == MenuTarget() ? @"command" : @"standard";
  }
  return described;
}

}

extern "C" ArdiaBridgeStatus ardia_bridge_menu_install(const char *json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!NSApp) return ARDIA_BRIDGE_NOT_STARTED;
    MenuRoles roles;
    NSMenu *bar = BuildMenuBar(Parse(json), roles);
    NSApp.mainMenu = bar;
    if (roles.services) NSApp.servicesMenu = roles.services;
    if (roles.windows) NSApp.windowsMenu = roles.windows;
    if (roles.help) NSApp.helpMenu = roles.help;
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_menu_build_describe(const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    MenuRoles roles;
    NSMenu *bar = BuildMenuBar(Parse(json), roles);
    NSMutableArray *menus = [NSMutableArray array];
    for (NSMenuItem *root in bar.itemArray)
      [menus addObject:@{@"title" : root.title ?: @"", @"items" : DescribeMenu(root.submenu)}];
    SetOut(out_json, @{
      @"menus" : menus,
      @"services" : @(roles.services != nil),
      @"windows" : @(roles.windows != nil),
      @"help" : @(roles.help != nil)
    });
    return ARDIA_BRIDGE_OK;
  });
}

namespace {

bool Background() {
  const char *flag = getenv("ARDIA_BACKGROUND");
  return gGuardInstalled.load() || (flag && strcmp(flag, "1") == 0);
}

NSAlert *BuildAlert(NSDictionary *spec, NSTextField *__autoreleasing *field) {
  NSAlert *alert = [NSAlert new];
  alert.messageText = OptStr(spec, @"title") ?: @"";
  alert.informativeText = OptStr(spec, @"message") ?: @"";
  NSString *style = OptStr(spec, @"style");
  alert.alertStyle = [style isEqualToString:@"critical"]        ? NSAlertStyleCritical
                     : [style isEqualToString:@"informational"] ? NSAlertStyleInformational
                                                                : NSAlertStyleWarning;
  NSArray<NSString *> *buttons = Strings(spec, @"buttons");
  if (!buttons.count) Bad(@"an alert needs at least one button");
  for (NSString *title in buttons) [alert addButtonWithTitle:title];
  if (Flag(spec, @"destructive")) alert.buttons.firstObject.hasDestructiveAction = YES;
  if (Flag(spec, @"noDefault")) alert.buttons.firstObject.keyEquivalent = @"";
  id cancel = spec[@"cancel"];
  if ([cancel isKindOfClass:NSNumber.class]) {
    const NSInteger index = [cancel integerValue];
    if (index < 0 || index >= (NSInteger)buttons.count) Bad(@"the cancel button is out of range");
    alert.buttons[index].keyEquivalent = @"\e";
  }
  if (NSString *suppression = OptStr(spec, @"suppression")) {
    alert.showsSuppressionButton = YES;
    alert.suppressionButton.title = suppression;
  }
  id fieldSpec = spec[@"field"];
  if ([fieldSpec isKindOfClass:NSDictionary.class]) {
    NSTextField *text = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 260, 24)];
    text.stringValue = OptStr(fieldSpec, @"value") ?: @"";
    text.placeholderString = OptStr(fieldSpec, @"placeholder");
    alert.accessoryView = text;
    if (field) *field = text;
  }
  return alert;
}

id EscapeButton(NSAlert *alert) {
  NSArray<NSButton *> *buttons = alert.buttons;
  for (NSUInteger i = 0; i < buttons.count; i++)
    if ([buttons[i].keyEquivalent isEqualToString:@"\e"]) return @(i);
  return NSNull.null;
}

NSDictionary *AlertAnswer(NSAlert *alert, NSModalResponse response, NSTextField *field) {
  const NSInteger index = response - NSAlertFirstButtonReturn;
  return @{
    @"button" : index >= 0 && index < (NSInteger)alert.buttons.count ? @(index) : NSNull.null,
    @"suppressed" : @(alert.showsSuppressionButton && alert.suppressionButton.state == NSControlStateValueOn),
    @"text" : field ? field.stringValue : NSNull.null,
    @"shown" : @YES,
  };
}

NSWindow *SheetParent(void *window) {
  NSWindow *parent = (__bridge NSWindow *)window;
  return parent && parent.isVisible && !parent.isMiniaturized ? parent : nil;
}

}

extern "C" ArdiaBridgeStatus ardia_bridge_alert(const char *json, void *window, uint64_t request) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *spec = Parse(json);
    NSTextField *field = nil;
    NSAlert *alert = BuildAlert(spec, &field);
    ABCompletion *done = [[ABCompletion alloc] initWithRequest:request];
    if (Background()) {
      NSLog(@"[ardia-engine] background: alert not shown: %@", alert.messageText);
      [done finish:@{@"button" : EscapeButton(alert), @"suppressed" : @NO, @"text" : field ? field.stringValue : NSNull.null, @"shown" : @NO}];
      return ARDIA_BRIDGE_OK;
    }
    if (field) alert.window.initialFirstResponder = field;
    if (NSWindow *parent = SheetParent(window)) {
      [alert beginSheetModalForWindow:parent completionHandler:^(NSModalResponse response) { [done finish:AlertAnswer(alert, response, field)]; }];
      return ARDIA_BRIDGE_OK;
    }
    dispatch_async(dispatch_get_main_queue(), ^{
      [done finish:AlertAnswer(alert, [alert runModal], field)];
    });
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_alert_describe(const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSTextField *field = nil;
    NSAlert *alert = BuildAlert(Parse(json), &field);
    NSMutableArray *buttons = [NSMutableArray array];
    for (NSButton *button in alert.buttons)
      [buttons addObject:@{@"title" : button.title ?: @"", @"key" : button.keyEquivalent ?: @"", @"destructive" : @(button.hasDestructiveAction)}];
    SetOut(out_json, @{
      @"title" : alert.messageText ?: @"",
      @"message" : alert.informativeText ?: @"",
      @"style" : @(alert.alertStyle),
      @"buttons" : buttons,
      @"cancel" : EscapeButton(alert),
      @"suppression" : alert.showsSuppressionButton ? alert.suppressionButton.title : NSNull.null,
      @"field" : field ? @{@"value" : field.stringValue ?: @"", @"placeholder" : field.placeholderString ?: @""} : NSNull.null,
    });
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_file_panel(const char *json, void *window, uint64_t request) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *spec = Parse(json);
    ABCompletion *done = [[ABCompletion alloc] initWithRequest:request];
    if (Background()) {
      NSLog(@"[ardia-engine] background: file panel not shown, cancelled");
      [done finish:@{@"paths" : @[], @"shown" : @NO}];
      return ARDIA_BRIDGE_OK;
    }
    const bool save = [OptStr(spec, @"kind") isEqualToString:@"save"];
    NSSavePanel *panel = nil;
    if (save) {
      NSSavePanel *savePanel = [NSSavePanel savePanel];
      savePanel.nameFieldStringValue = OptStr(spec, @"name") ?: @"";
      savePanel.canCreateDirectories = YES;
      panel = savePanel;
    } else {
      NSOpenPanel *openPanel = [NSOpenPanel openPanel];
      openPanel.allowsMultipleSelection = Flag(spec, @"multiple");
      openPanel.canChooseFiles = ![spec[@"files"] isEqual:@NO];
      openPanel.canChooseDirectories = Flag(spec, @"directories");
      openPanel.canCreateDirectories = Flag(spec, @"createDirectories");
      panel = openPanel;
    }
    if (NSString *prompt = OptStr(spec, @"prompt")) panel.prompt = prompt;
    if (NSString *message = OptStr(spec, @"message")) panel.message = message;
    if (NSString *directory = OptStr(spec, @"directory")) panel.directoryURL = [NSURL fileURLWithPath:directory isDirectory:YES];
    NSMutableArray<UTType *> *types = [NSMutableArray array];
    for (NSString *extension in Strings(spec, @"extensions"))
      if (UTType *type = [UTType typeWithFilenameExtension:extension]) [types addObject:type];
    if (types.count) panel.allowedContentTypes = types;
    __weak NSSavePanel *weakPanel = panel;
    void (^finish)(NSModalResponse) = ^(NSModalResponse response) {
      NSSavePanel *shown = weakPanel;
      NSMutableArray<NSString *> *paths = [NSMutableArray array];
      if (response == NSModalResponseOK && shown) {
        if (save) {
          if (NSString *path = shown.URL.path) [paths addObject:path];
        } else {
          for (NSURL *url in ((NSOpenPanel *)shown).URLs)
            if (url.path) [paths addObject:url.path];
        }
      }
      [done finish:@{@"paths" : paths, @"shown" : @YES}];
    };
    if (NSWindow *parent = SheetParent(window)) [panel beginSheetModalForWindow:parent completionHandler:finish];
    else [panel beginWithCompletionHandler:finish];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_share(const char *json, void *view, double x, double y, double width, double height) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *spec = Parse(json);
    NSMutableArray *items = [NSMutableArray array];
    for (id item in List(spec, @"items")) {
      if (![item isKindOfClass:NSDictionary.class]) continue;
      if (NSString *url = OptStr(item, @"url"))
        if (NSURL *link = [NSURL URLWithString:url]; link.scheme.length) [items addObject:link];
      if (NSString *text = OptStr(item, @"text")) [items addObject:text];
    }
    if (!items.count || !view) return ARDIA_BRIDGE_BAD_ARGUMENT;
    if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height)) return ARDIA_BRIDGE_BAD_ARGUMENT;
    if (Background()) {
      NSLog(@"[ardia-engine] background: share picker not shown (%lu items)", (unsigned long)items.count);
      return ARDIA_BRIDGE_OK;
    }
    NSView *anchor = (__bridge NSView *)view;
    if (!anchor.window) return ARDIA_BRIDGE_BAD_ARGUMENT;
    static NSSharingServicePicker *shown = nil;
    shown = [[NSSharingServicePicker alloc] initWithItems:items];
    [shown showRelativeToRect:NSMakeRect(x, y, width, height) ofView:anchor preferredEdge:NSRectEdgeMinY];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_workspace(const char *json, char **out_json) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSDictionary *spec = Parse(json);
    NSString *op = OptStr(spec, @"op");
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    if ([op isEqualToString:@"openUrl"]) {
      NSURL *url = [NSURL URLWithString:Str(spec, @"url")];
      if (!url.scheme.length) Bad(@"that isn't a URL");
      if (Background()) {
        NSLog(@"[ardia-engine] background: %@ link not opened", url.scheme);
        SetOut(out_json, @NO);
      } else {
        SetOut(out_json, @([workspace openURL:url]));
      }
    } else if ([op isEqualToString:@"openPath"]) {
      NSURL *url = [NSURL fileURLWithPath:Str(spec, @"path")];
      SetOut(out_json, Background() ? @NO : @([workspace openURL:url]));
    } else if ([op isEqualToString:@"reveal"]) {
      NSMutableArray<NSURL *> *urls = [NSMutableArray array];
      for (NSString *path in Strings(spec, @"paths")) [urls addObject:[NSURL fileURLWithPath:path]];
      if (!urls.count) Bad(@"nothing to reveal");
      if (Background()) {
        SetOut(out_json, @NO);
      } else {
        [workspace activateFileViewerSelectingURLs:urls];
        SetOut(out_json, @YES);
      }
    } else {
      Bad(@"unknown workspace request");
    }
    return ARDIA_BRIDGE_OK;
  });
}

@interface ABAppEvents : NSObject
- (void)getURL:(NSAppleEventDescriptor *)event withReply:(NSAppleEventDescriptor *)reply;
- (void)reopen:(NSAppleEventDescriptor *)event withReply:(NSAppleEventDescriptor *)reply;
@end

@implementation ABAppEvents

- (void)getURL:(NSAppleEventDescriptor *)event withReply:(NSAppleEventDescriptor *)reply {
  NSString *url = [event paramDescriptorForKeyword:keyDirectObject].stringValue;
  if (!url.length) return;
  NSMutableDictionary *opened = [@{@"event" : @"openUrls", @"urls" : @[ url ]} mutableCopy];
  pid_t pid = 0;
  NSData *token = [event attributeDescriptorForKeyword:keySenderAuditTokenAttr].data;
  if (token.length == sizeof(audit_token_t)) {
    audit_token_t audit;
    memcpy(&audit, token.bytes, sizeof audit);
    pid = (pid_t)audit.val[5];
  }
  if (pid <= 0) pid = [event attributeDescriptorForKeyword:keySenderPIDAttr].int32Value;
  if (pid > 0) {
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    NSString *name = app.localizedName;
    char process[2 * MAXCOMLEN + 1] = {};
    if (!name.length && proc_name(pid, process, sizeof process) > 0) name = @(process);
    if (app.bundleIdentifier.length) opened[@"bundleId"] = app.bundleIdentifier;
    if (name.length) opened[@"appName"] = name;
  }
  Emit(opened);
}

- (void)reopen:(NSAppleEventDescriptor *)event withReply:(NSAppleEventDescriptor *)reply {
  bool visible = false;
  for (NSWindow *window in NSApp.windows) visible = visible || window.isVisible;
  Emit(@{@"event" : @"reopen", @"visible" : @(visible)});
}

@end

extern "C" ArdiaBridgeStatus ardia_bridge_install_app_events(bool urls, bool reopen) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    static ABAppEvents *handler = [ABAppEvents new];
    NSAppleEventManager *manager = NSAppleEventManager.sharedAppleEventManager;
    if (urls)
      [manager setEventHandler:handler andSelector:@selector(getURL:withReply:) forEventClass:kInternetEventClass andEventID:kAEGetURL];
    if (reopen)
      [manager setEventHandler:handler andSelector:@selector(reopen:withReply:) forEventClass:kCoreEventClass andEventID:kAEReopenApplication];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_set_handoff(void *window, const char *url, const char *title) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSWindow *target = (__bridge NSWindow *)window;
    if (!target) return ARDIA_BRIDGE_BAD_ARGUMENT;
    NSString *link = Text(url);
    NSURL *page = link ? [NSURL URLWithString:link] : nil;
    NSString *scheme = page.scheme.lowercaseString;
    const bool web = [scheme isEqualToString:@"http"] || [scheme isEqualToString:@"https"];
    if (!web || Background()) {
      [target.userActivity invalidate];
      target.userActivity = nil;
      return ARDIA_BRIDGE_OK;
    }
    if ([target.userActivity.webpageURL isEqual:page]) {
      target.userActivity.title = Text(title);
      return ARDIA_BRIDGE_OK;
    }
    [target.userActivity invalidate];
    NSUserActivity *activity = [[NSUserActivity alloc] initWithActivityType:NSUserActivityTypeBrowsingWeb];
    activity.webpageURL = page;
    activity.title = Text(title);
    activity.eligibleForHandoff = YES;
    target.userActivity = activity;
    if (target.isKeyWindow) [activity becomeCurrent];
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_hosted_hooks_install(const ArdiaHostedWindowHooks *hooks) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!hooks || hooks->size < sizeof(ArdiaHostedWindowHooks) || !hooks->send_event || !hooks->key_down ||
        !hooks->make_first_responder || !hooks->perform_key_equivalent)
      return ARDIA_BRIDGE_BAD_ARGUMENT;
    if (hosted::Active()) return hosted::SameHooks(hosted::gHooks, *hooks) ? ARDIA_BRIDGE_OK : ARDIA_BRIDGE_ALREADY_RUNNING;
    hosted::gHooks = *hooks;
    hosted::gHooks.size = sizeof(ArdiaHostedWindowHooks);
    hosted::gActive.store(true, std::memory_order_release);
    for (ArdiaCoreWindow *window in [Windows() liveObjects]) hosted::AttachIfActive(window.window);
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_hosted_hooks_remove(uint64_t *restored) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    for (NSWindow *window in hosted::Attached().allObjects) hosted::Detach(window);
    [hosted::Attached() removeAllObjects];
    hosted::gActive.store(false, std::memory_order_release);
    hosted::gHooks = {};
    const uint64_t count = hosted::RestoreAll();
    if (restored) *restored = count;
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_style_browser_window(void *window) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSWindow *target = (__bridge NSWindow *)window;
    if (![target isKindOfClass:NSWindow.class]) return ARDIA_BRIDGE_BAD_ARGUMENT;
    StyleBrowserWindow(target);
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" bool ardia_bridge_hosted_hooks_installed(void) {
  return hosted::Active();
}

extern "C" ArdiaBridgeStatus ardia_bridge_hosted_window_attach(void *window) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!window) return ARDIA_BRIDGE_BAD_ARGUMENT;
    return hosted::Attach((__bridge NSWindow *)window);
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_hosted_window_attach_engine(uint64_t windowId) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    if (!hosted::Active()) return ARDIA_BRIDGE_NO_HOST;
    ArdiaCoreWindow *window = [Windows() objectFor:windowId];
    if (!window || !window.window) return ARDIA_BRIDGE_UNKNOWN_WINDOW;
    return hosted::Attach(window.window);
  });
}

extern "C" ArdiaBridgeStatus ardia_bridge_hosted_window_detach(void *window) {
  return Guarded([&]() -> ArdiaBridgeStatus {
    NSWindow *target = (__bridge NSWindow *)window;
    if (![target isKindOfClass:NSWindow.class]) return ARDIA_BRIDGE_BAD_ARGUMENT;
    hosted::Detach(target);
    return ARDIA_BRIDGE_OK;
  });
}

extern "C" bool ardia_bridge_hosted_window_attached(void *window) {
  if (!window || !NSThread.isMainThread) return false;
  return objc_getAssociatedObject((__bridge id)window, hosted::kHostedClassKey) != nil;
}

extern "C" uint64_t ardia_bridge_hosted_window_count(void) {
  if (!NSThread.isMainThread) return 0;
  @autoreleasepool {
    return hosted::Attached().allObjects.count;
  }
}
