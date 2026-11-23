#import "ArdiaWebViewInternal.h"
#import "ArdiaLaunchConfig.h"
#import "ArdiaRuntime.h"

#import <objc/message.h>
#import <objc/runtime.h>
#import <os/log.h>

#include <cmath>

using namespace ardia_web_view;
using namespace ardia_runtime;

namespace {

NSDictionary<NSString *, NSDictionary *> *gFieldProviders = @{};
double gFieldProviderGeneration = -1;
NSString *gFieldProviderSession = @"";
const NSTimeInterval kFocusQuerySeconds = 0.2;
NSString *const kInsertFromPasswordsAction = @"_handleInsertFromPasswordsCommand:";
NSString *const kShowOrHideAutoFill = @"_showOrHideAutoFillForCurrentTextInputContextIfAppropriate";
NSString *const kSystemPanelOwner = @"AutoFillPanelService";
const CFTimeInterval kAutoFillHeuristicsHold = 1.5;
const CFTimeInterval kSystemPanelFirstCheck = 0.6;
const CFTimeInterval kSystemPanelLastCheck = 1.5;
CFTimeInterval gHoldAutoFillHeuristicsUntil = 0;
bool gAutoFillPassSkipped = false;
IMP gShowOrHideAutoFill = nullptr;
NSView *__weak gHeldPage = nil;
enum class SystemPanelSight { Seen, Missing, Unknown };
const CFTimeInterval kSystemPanelInterval = 0.6;
const NSUInteger kVerificationCodesPerPage = 8;

NSString *const kFillSystem = @"system";
NSString *const kFillMenu = @"menu";

BOOL FillsFromSystemPanel(NSDictionary *provider) { return [provider[@"fill"] isEqual:kFillSystem]; }

BOOL ProviderWants(NSDictionary *provider, NSString *field) {
  if (!FillsFromSystemPanel(provider)) return NO;
  if ([field isEqualToString:@"code"]) return Flag(provider, @"oneTimeCode");
  if ([field isEqualToString:@"username"] || [field isEqualToString:@"password"]) return Flag(provider, @"login");
  return NO;
}

}

namespace ardia_web_view {

NSDictionary *FieldProviderFor(NSString *profile) {
  return gFieldProviders[ardia_host::OriginalProfileName(profile ?: @"")];
}

NSString *FieldProviderJSON(NSString *profile) {
  NSDictionary *provider = FieldProviderFor(profile);
  return provider ? JSONText(provider) : @"false";
}

}

namespace {

static NSMapTable<id, NSMutableDictionary *> *FieldProviderPages() {
  static NSMapTable *pages = [NSMapTable weakToStrongObjectsMapTable];
  return pages;
}

static NSMutableDictionary *FieldProviderPage(id owner) {
  if (!owner) return nil;
  NSMutableDictionary *page = [FieldProviderPages() objectForKey:owner];
  if (!page) {
    page = [NSMutableDictionary dictionaryWithDictionary:@{@"navigation" : @0, @"tokens" : [NSMutableDictionary dictionary]}];
    [FieldProviderPages() setObject:page forKey:owner];
  }
  return page;
}

static NSURL *VerificationSetupURL(NSString *text) {
  if (![text isKindOfClass:NSString.class] || !text.length || text.length > 2048) return nil;
  NSURLComponents *parts = [NSURLComponents componentsWithString:text];
  NSString *scheme = parts.scheme.lowercaseString, *host = parts.host.lowercaseString;
  if (!scheme || !host) return nil;
  BOOL (^has)(NSString *) = ^BOOL(NSString *name) {
    for (NSURLQueryItem *item in parts.queryItems)
      if ([item.name.lowercaseString isEqualToString:name] && item.value.length) return YES;
    return NO;
  };
  const BOOL valid = ([scheme isEqualToString:@"otpauth"] && ([host isEqualToString:@"totp"] || [host isEqualToString:@"hotp"]) && has(@"secret")) ||
                     ([scheme isEqualToString:@"otpauth-migration"] && [host isEqualToString:@"offline"] && has(@"data"));
  return valid ? parts.URL : nil;
}

static NSURL *VerificationCodeHandler(NSURL *url) {
  return url ? [NSWorkspace.sharedWorkspace URLForApplicationToOpenURL:url] : nil;
}

static NSString *AppName(NSURL *app) {
  if (!app) return nil;
  NSString *name = [NSFileManager.defaultManager displayNameAtPath:app.path];
  return [name.pathExtension isEqualToString:@"app"] ? name.stringByDeletingPathExtension : name;
}

static BOOL EditsWebText(NSResponder *responder, NSView *page) {
  if (![responder isKindOfClass:NSView.class] || !page || ![(NSView *)responder isDescendantOf:page]) return NO;
  SEL inputType = NSSelectorFromString(@"textInputType");
  if ([responder respondsToSelector:inputType]) {
    const char *returns = [responder methodSignatureForSelector:inputType].methodReturnType;
    const char kind = returns ? returns[0] : 0;
    if (kind == 'i' || kind == 'I') return ((int (*)(id, SEL))objc_msgSend)(responder, inputType) != 0;
    if (kind == 'q' || kind == 'Q' || kind == 'l' || kind == 'L') return ((long (*)(id, SEL))objc_msgSend)(responder, inputType) != 0;
    return NO;
  }
  return [responder conformsToProtocol:@protocol(NSTextInputClient)] && ((NSView *)responder).inputContext != nil;
}

static BOOL SystemPanelActionExists() {
  return NSClassFromString(@"NSAutoFillHeuristicController") && [NSApplication instancesRespondToSelector:NSSelectorFromString(kInsertFromPasswordsAction)];
}


id AutoFillController() {
  Class heuristic = NSClassFromString(@"NSAutoFillHeuristicController");
  SEL shared = NSSelectorFromString(@"sharedInstance");
  return [heuristic respondsToSelector:shared] ? ((id (*)(id, SEL))objc_msgSend)(heuristic, shared) : nil;
}

void RunSkippedAutoFillPass() {
  if (!gAutoFillPassSkipped || !gShowOrHideAutoFill) return;
  gAutoFillPassSkipped = false;
  os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel hold ended, replaying AppKit's autofill pass");
  if (id controller = AutoFillController()) ((void (*)(id, SEL))gShowOrHideAutoFill)(controller, NSSelectorFromString(kShowOrHideAutoFill));
}

void EndAutoFillHold() {
  gHoldAutoFillHeuristicsUntil = 0;
  gHeldPage = nil;
  RunSkippedAutoFillPass();
}

bool HoldStillCoversResponder() {
  NSView *page = gHeldPage;
  NSResponder *responder = page.window.firstResponder;
  return page && [responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:page];
}

bool AutoFillHeuristicsHeld() {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    Class heuristic = NSClassFromString(@"NSAutoFillHeuristicController");
    SEL sel = NSSelectorFromString(kShowOrHideAutoFill);
    Method method = heuristic ? class_getInstanceMethod(heuristic, sel) : nullptr;
    if (!method) return;
    IMP original = method_getImplementation(method);
    method_setImplementation(method, imp_implementationWithBlock(^(id controller) {
      if (CACurrentMediaTime() < gHoldAutoFillHeuristicsUntil) {
        if (HoldStillCoversResponder()) {
          gAutoFillPassSkipped = true;
          return;
        }
        gHoldAutoFillHeuristicsUntil = 0;
        gHeldPage = nil;
        gAutoFillPassSkipped = false;
        os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel hold ended early: the responder left the page");
      }
      ((void (*)(id, SEL))original)(controller, sel);
    }));
    gShowOrHideAutoFill = original;
  });
  return gShowOrHideAutoFill != nullptr;
}

void HoldAutoFillHeuristics(NSView *page) {
  const CFTimeInterval until = CACurrentMediaTime() + kAutoFillHeuristicsHold;
  gHoldAutoFillHeuristicsUntil = until;
  gHeldPage = page;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kAutoFillHeuristicsHold * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (gHoldAutoFillHeuristicsUntil != until) return;
    EndAutoFillHold();
  });
}

NSDictionary<NSNumber *, NSValue *> *PanelWindowFrames(bool *namesHidden) {
  NSArray<NSDictionary *> *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
  const pid_t me = getpid();
  NSMutableDictionary<NSNumber *, NSValue *> *frames = [NSMutableDictionary dictionary];
  for (NSDictionary *window in windows) {
    NSString *owner = window[(id)kCGWindowOwnerName];
    if ([window[(id)kCGWindowOwnerPID] intValue] != me && !owner.length && namesHidden) *namesHidden = true;
    if (![owner isEqualToString:kSystemPanelOwner]) continue;
    CGRect bounds;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)window[(id)kCGWindowBounds], &bounds)) continue;
    if (bounds.size.width >= 100 && bounds.size.height >= 100) frames[window[(id)kCGWindowNumber]] = [NSValue valueWithRect:NSRectFromCGRect(bounds)];
  }
  return frames;
}

NSIndexSet *PanelWindowNumbers(bool *namesHidden) {
  NSMutableIndexSet *numbers = [NSMutableIndexSet indexSet];
  for (NSNumber *number in PanelWindowFrames(namesHidden)) [numbers addIndex:number.unsignedIntegerValue];
  return numbers;
}

SystemPanelSight SightOfSystemPanel(NSIndexSet *before, CGRect *frame) {
  bool namesHidden = false;
  NSDictionary<NSNumber *, NSValue *> *frames = PanelWindowFrames(&namesHidden);
  for (NSNumber *number in frames) {
    if ([before containsIndex:number.unsignedIntegerValue]) continue;
    if (frame) *frame = NSRectToCGRect(frames[number].rectValue);
    return SystemPanelSight::Seen;
  }
  return namesHidden ? SystemPanelSight::Unknown : SystemPanelSight::Missing;
}

NSString *SideOfSystemPanel(NSView *page, CGRect panel) {
  id responder = page.window.firstResponder;
  if (![responder conformsToProtocol:@protocol(NSTextInputClient)] || CGRectIsEmpty(panel)) return nil;
  id<NSTextInputClient> client = responder;
  const NSRect caret = [client firstRectForCharacterRange:[client selectedRange] actualRange:nullptr];
  NSScreen *primary = NSScreen.screens.firstObject;
  if (!primary || (NSIsEmptyRect(caret) && NSEqualPoints(caret.origin, NSZeroPoint))) return nil;
  const CGFloat caretMiddle = NSHeight(primary.frame) - NSMidY(caret);
  return CGRectGetMidY(panel) >= caretMiddle ? @"below" : @"above";
}

NSString *LoggedFieldKind(NSString *field) {
  if (!field) return @"-";
  return [@[ @"username", @"password", @"code" ] containsObject:field] ? field : @"other";
}

void ReportSystemPanelSight(NSIndexSet *before, NSView *page, void (^done)(NSDictionary *result)) {
  __weak NSView *weakPage = page;
  void (^answer)(SystemPanelSight, CGRect) = ^(SystemPanelSight sight, CGRect frame) {
    NSString *side = sight == SystemPanelSight::Seen ? SideOfSystemPanel(weakPage, frame) : nil;
    os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel %{public}s%{public}s%{public}@",
           sight == SystemPanelSight::Seen ? "seen" : sight == SystemPanelSight::Missing ? "missing" : "unchecked", side ? " panel=" : "", side ?: @"");
    if (sight == SystemPanelSight::Missing) return done(@{@"shown" : @NO, @"reason" : @"noPanel"});
    done(side ? @{@"shown" : @YES, @"panel" : side} : @{@"shown" : @YES});
  };
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kSystemPanelFirstCheck * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    CGRect frame = CGRectZero;
    const SystemPanelSight first = SightOfSystemPanel(before, &frame);
    if (first != SystemPanelSight::Missing) return answer(first, frame);
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)((kSystemPanelLastCheck - kSystemPanelFirstCheck) * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      CGRect later = CGRectZero;
      const SystemPanelSight last = SightOfSystemPanel(before, &later);
      answer(last, later);
    });
  });
}

NSUInteger gPanelHintWatch = 0;
const CFTimeInterval kPanelHintPoll = 0.25;
const CFTimeInterval kPanelHintLongest = 120;

void WatchSystemPanelUntilClosed(NSUInteger watch, CFTimeInterval started, void (^closed)(void)) {
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kPanelHintPoll * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    if (watch != gPanelHintWatch) return;
    bool namesHidden = false;
    const bool open = PanelWindowFrames(&namesHidden).count > 0 || namesHidden;
    if (open && CACurrentMediaTime() - started < kPanelHintLongest) return WatchSystemPanelUntilClosed(watch, started, closed);
    closed();
  });
}

NSString *PanelHintJSON(NSString *label, NSString *side) {
  static NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$" options:0 error:nil];
  if (![label isKindOfClass:NSString.class] || ![pattern firstMatchInString:label options:0 range:NSMakeRange(0, label.length)]) return nil;
  if (![@[ @"above", @"below" ] containsObject:side ?: @""]) return nil;
  return JSONText(@{@"label" : label, @"side" : side});
}

void OpenSystemPanel(NSView *page, void (^done)(NSDictionary *result)) {
  static CFTimeInterval lastAt = -kSystemPanelInterval;
  NSWindow *window = page.window;
  if (!SystemPanelActionExists()) return done(@{@"shown" : @NO, @"reason" : @"unavailable"});
  if (!window.isKeyWindow) return done(@{@"shown" : @NO, @"reason" : @"notKey"});
  if (!EditsWebText(window.firstResponder, page)) return done(@{@"shown" : @NO, @"reason" : @"notEditing"});
  const CFTimeInterval now = CACurrentMediaTime();
  if (now - lastAt < kSystemPanelInterval) return done(@{@"shown" : @NO, @"reason" : @"throttled"});
  lastAt = now;
  ArdiaLaunchConfig *config = ArdiaLaunchConfig.shared;
  if (config.background && ![config testFlag:@"applePasswordsPanel"]) {
    os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel (background mode, not shown) responder=%{public}s",
           class_getName([window.firstResponder class]));
    return done(@{@"shown" : @YES});
  }
  NSIndexSet *before = PanelWindowNumbers(nullptr);
  const bool held = AutoFillHeuristicsHeld();
  if (held) HoldAutoFillHeuristics(page);
  SEL action = NSSelectorFromString(kInsertFromPasswordsAction);
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:@"AutoFill" action:action keyEquivalent:@""];
  id target = [NSApp targetForAction:action to:nil from:item];
  const BOOL sent = target && [NSApp sendAction:action to:target from:item];
  os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel responder=%{public}s target=%{public}s sent=%d held=%d", class_getName([window.firstResponder class]),
         class_getName([target class]), sent, held);
  if (!sent) {
    if (held) EndAutoFillHold();
    return done(@{@"shown" : @NO, @"reason" : @"refused"});
  }
  if ([config testFlag:@"systemPanelRace"]) {
    id controller = AutoFillController();
    SEL pass = NSSelectorFromString(kShowOrHideAutoFill);
    if ([controller respondsToSelector:pass]) ((void (*)(id, SEL))objc_msgSend)(controller, pass);
  }
  ReportSystemPanelSight(before, page, done);
}

}

@implementation ArdiaWebView (FieldProviders)

+ (BOOL)setFieldProviders:(NSArray<NSDictionary *> *)profiles generation:(double)generation session:(NSString *)session {
  if (!std::isfinite(generation) || !session.length) return NO;
  const BOOL newSession = ![session isEqualToString:gFieldProviderSession];
  if (!newSession && generation < gFieldProviderGeneration) return NO;
  NSMutableDictionary<NSString *, NSDictionary *> *providers = [NSMutableDictionary dictionary];
  for (NSDictionary *entry in profiles) {
    if (![entry isKindOfClass:NSDictionary.class]) continue;
    NSString *profile = Field<NSString>(entry, @"profile");
    NSArray *fields = Field<NSArray>(entry, @"fields") ?: @[];
    const BOOL login = [fields containsObject:@"login"], oneTimeCode = [fields containsObject:@"oneTimeCode"], codeSetup = Flag(entry, @"codeSetup");
    NSString *fill = [Field<NSString>(entry, @"fill") isEqualToString:kFillMenu] ? kFillMenu : kFillSystem;
    if (!profile || !(login || oneTimeCode || codeSetup)) continue;
    providers[ardia_host::OriginalProfileName(profile)] = @{
      @"login" : @(login),
      @"oneTimeCode" : @(oneTimeCode),
      @"codeSetup" : @(codeSetup && [fill isEqualToString:kFillSystem]),
      @"generation" : @(generation),
      @"fill" : fill
    };
  }
  const BOOL changed = newSession || generation != gFieldProviderGeneration || ![providers isEqualToDictionary:gFieldProviders];
  gFieldProviderSession = [session copy];
  gFieldProviderGeneration = generation;
  gFieldProviders = providers;
  if (!changed) return YES;
  for (NSMutableDictionary *page in FieldProviderPages().objectEnumerator) {
    [page removeObjectForKey:@"focus"];
    [page removeObjectForKey:@"focusSeq"];
    [page[@"tokens"] removeAllObjects];
  }
  for (ArdiaWebView *view in LiveViews().allObjects) [view pushFieldProvider];
  return YES;
}

+ (NSDictionary *)fieldProviderForProfile:(NSString *)profile {
  return FieldProviderFor(profile);
}

+ (NSDictionary<NSString *, NSNumber *> *)systemPanelAvailability {
  Class heuristic = NSClassFromString(@"NSAutoFillHeuristicController");
  const BOOL action = SystemPanelActionExists();
  return @{
    @"chromium" : @(action && [heuristic respondsToSelector:NSSelectorFromString(@"_inputContextForChromiumSecureTextFieldFromResponder:")]),
    @"webkit" : @(action),
  };
}

+ (NSString *)otpauthHandlerName {
  return AppName(VerificationCodeHandler([NSURL URLWithString:@"otpauth://totp/Ardia?secret=A"]));
}

+ (void)noteFieldFocus:(NSString *)field sequence:(double)sequence generation:(double)generation query:(NSString *)query owner:(id)owner {
  if (generation != gFieldProviderGeneration || !std::isfinite(sequence) || sequence < 1) return;
  NSMutableDictionary *page = FieldProviderPage(owner);
  if (sequence <= [page[@"focusSeq"] doubleValue]) return;
  page[@"focusSeq"] = @(sequence);
  if ([@[ @"username", @"password", @"code" ] containsObject:field ?: @""]) page[@"focus"] = field;
  else [page removeObjectForKey:@"focus"];
  if (!query.length || ![query isEqualToString:page[@"query"]]) return;
  NSDictionary *pending = page[@"queryPending"];
  [page removeObjectForKey:@"query"];
  [page removeObjectForKey:@"queryPending"];
  void (^completion)(NSDictionary *) = pending[@"completion"];
  if (CACurrentMediaTime() > [pending[@"deadline"] doubleValue]) return completion(@{@"shown" : @NO, @"reason" : @"notFocused"});
  [ArdiaWebView requestSystemPanelIn:pending[@"view"]
                               owner:owner
                             profile:pending[@"profile"]
                               field:nil
                          generation:[pending[@"generation"] doubleValue]
                          completion:completion];
}

+ (void)querySystemPanelIn:(NSView *)view
                     owner:(id)owner
                   profile:(NSString *)profile
                generation:(double)generation
                       ask:(void (^)(NSString *query))ask
                completion:(void (^)(NSDictionary *result))completion {
  if (!FillsFromSystemPanel(FieldProviderFor(profile))) return completion(@{@"shown" : @NO, @"reason" : @"noProvider"});
  if (generation >= 0 && generation != gFieldProviderGeneration) return completion(@{@"shown" : @NO, @"reason" : @"stale"});
  NSMutableDictionary *page = FieldProviderPage(owner);
  NSDictionary *superseded = page[@"queryPending"];
  if (superseded) ((void (^)(NSDictionary *))superseded[@"completion"])(@{@"shown" : @NO, @"reason" : @"notFocused"});
  NSString *query = NSUUID.UUID.UUIDString;
  __block void (^answer)(NSDictionary *) = [completion copy];
  void (^answerOnce)(NSDictionary *) = ^(NSDictionary *result) {
    void (^waiting)(NSDictionary *) = answer;
    answer = nil;
    if (waiting) waiting(result);
  };
  page[@"query"] = query;
  page[@"queryPending"] = @{
    @"view" : view,
    @"profile" : profile ?: @"",
    @"generation" : @(generation),
    @"deadline" : @(CACurrentMediaTime() + kFocusQuerySeconds),
    @"completion" : answerOnce,
  };
  __weak id weakOwner = owner;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kFocusQuerySeconds * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    NSMutableDictionary *waiting = weakOwner ? [FieldProviderPages() objectForKey:weakOwner] : nil;
    const BOOL unanswered = [waiting[@"query"] isEqualToString:query];
    if (unanswered) {
      [waiting removeObjectForKey:@"query"];
      [waiting removeObjectForKey:@"queryPending"];
    }
    if (!waiting) {
      os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel refused reason=tabGone via=menu field=-");
      answerOnce(@{@"shown" : @NO, @"reason" : @"tabGone"});
    } else if (unanswered) {
      answerOnce(@{@"shown" : @NO, @"reason" : @"notFocused"});
    }
  });
  ask(query);
}

+ (void)resetFieldProviderPage:(id)owner {
  NSMutableDictionary *page = FieldProviderPage(owner);
  page[@"navigation"] = @([page[@"navigation"] longLongValue] + 1);
  [page removeObjectForKey:@"focus"];
  [page removeObjectForKey:@"focusSeq"];
  [page[@"tokens"] removeAllObjects];
  NSDictionary *pending = page[@"queryPending"];
  [page removeObjectForKey:@"query"];
  [page removeObjectForKey:@"queryPending"];
  if (pending) ((void (^)(NSDictionary *))pending[@"completion"])(@{@"shown" : @NO, @"reason" : @"notFocused"});
}

+ (void)dropVerificationCodesOf:(id)owner frame:(NSString *)frame {
  NSMutableDictionary<NSString *, NSDictionary *> *tokens = [FieldProviderPages() objectForKey:owner][@"tokens"];
  if (!frame) return [tokens removeAllObjects];
  for (NSString *token in tokens.allKeys)
    if ([tokens[token][@"frame"] isEqualToString:frame]) [tokens removeObjectForKey:token];
}

+ (void)requestSystemPanelIn:(NSView *)page
                       owner:(id)owner
                     profile:(NSString *)profile
                       field:(NSString *)field
                  generation:(double)generation
                  completion:(void (^)(NSDictionary *result))completion {
  void (^done)(NSDictionary *) = ^(NSDictionary *result) {
    NSString *reason = result[@"reason"];
    if (reason)
      os_log(OS_LOG_DEFAULT, "[ardiacore] system passwords panel refused reason=%{public}@ via=%{public}s field=%{public}@", reason, field ? "badge" : "menu",
             LoggedFieldKind(field));
    completion(result);
  };
  NSDictionary *provider = FieldProviderFor(profile);
  if (!FillsFromSystemPanel(provider)) return done(@{@"shown" : @NO, @"reason" : @"noProvider"});
  if ((field || generation >= 0) && generation != gFieldProviderGeneration) return done(@{@"shown" : @NO, @"reason" : @"stale"});
  NSString *focus = FieldProviderPage(owner)[@"focus"];
  if (!ProviderWants(provider, focus) || (field && ![field isEqualToString:focus])) return done(@{@"shown" : @NO, @"reason" : @"notFocused"});
  OpenSystemPanel(page, done);
}

+ (NSDictionary *)offerVerificationCode:(NSString *)text owner:(id)owner frame:(NSString *)frame profile:(NSString *)profile generation:(double)generation {
  NSDictionary *provider = FieldProviderFor(profile);
  NSURL *url = VerificationSetupURL(text);
  NSURL *handler = VerificationCodeHandler(url);
  NSString *app = AppName(handler);
  if (!Flag(provider, @"codeSetup") || generation != gFieldProviderGeneration || !url || !handler || !app.length || !frame) return nil;
  NSMutableDictionary *page = FieldProviderPage(owner);
  NSMutableDictionary<NSString *, NSDictionary *> *tokens = page[@"tokens"];
  for (NSDictionary *offer in tokens.allValues)
    if ([offer[@"url"] isEqual:url]) return nil;
  if (tokens.count >= kVerificationCodesPerPage) return nil;
  NSString *token = NSUUID.UUID.UUIDString;
  tokens[token] = @{
    @"url" : url,
    @"frame" : frame,
    @"navigation" : page[@"navigation"],
    @"profile" : ardia_host::OriginalProfileName(profile ?: @""),
    @"generation" : @(generation),
    @"handler" : handler.path ?: @"",
  };
  return @{@"token" : token, @"app" : app};
}

+ (void)redeemVerificationCode:(NSString *)token
                         owner:(id)owner
                       profile:(NSString *)profile
                    generation:(double)generation
                    frameAlive:(BOOL (^)(NSString *frame))frameAlive
                    completion:(void (^)(NSDictionary *result))completion {
  NSMutableDictionary *page = FieldProviderPage(owner);
  NSDictionary *offer = token.length ? page[@"tokens"][token] : nil;
  if (offer) [page[@"tokens"] removeObjectForKey:token];
  NSDictionary *(^refuse)(NSString *) = ^(NSString *reason) { return @{@"opened" : @NO, @"reason" : reason}; };
  if (!offer) return completion(refuse(@"unknownToken"));
  if ((generation >= 0 && generation != gFieldProviderGeneration) || [offer[@"generation"] doubleValue] != gFieldProviderGeneration)
    return completion(refuse(@"stale"));
  if (![offer[@"navigation"] isEqual:page[@"navigation"]]) return completion(refuse(@"navigated"));
  if (![offer[@"profile"] isEqualToString:ardia_host::OriginalProfileName(profile ?: @"")] || !Flag(FieldProviderFor(profile), @"codeSetup"))
    return completion(refuse(@"noProvider"));
  if (!frameAlive(offer[@"frame"])) return completion(refuse(@"frameGone"));
  NSURL *url = offer[@"url"];
  NSURL *handler = VerificationCodeHandler(url);
  if (!handler || ![handler.path isEqualToString:offer[@"handler"]]) return completion(refuse(@"handlerChanged"));
  if (ArdiaLaunchConfig.shared.background) {
    NSLog(@"[ardiacore] verification code setup (background mode, not opened) handler=%@", AppName(handler));
    return completion(@{@"opened" : @YES});
  }
  NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
  configuration.activates = YES;
  [NSWorkspace.sharedWorkspace openURLs:@[ url ]
                   withApplicationAtURL:handler
                          configuration:configuration
                      completionHandler:^(NSRunningApplication *app, NSError *error) {
                        dispatch_async(dispatch_get_main_queue(), ^{
                          completion(app && !error ? @{@"opened" : @YES} : refuse(@"failed"));
                        });
                      }];
}

+ (BOOL)showSystemPanelForTab:(NSString *)tabId generation:(double)generation completion:(void (^)(NSDictionary *result))completion {
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  ArdiaWebView *view = tab ? [ArdiaTabRegistry viewForTab:tab] : nil;
  if (!view || !tab.view) return NO;
  __weak ArdiaWebView *weakView = view;
  [ArdiaWebView querySystemPanelIn:tab.view
      owner:tab
      profile:view->_profile
      generation:generation
      ask:^(NSString *query) {
        [weakView callFrame:@"" kind:@"fieldFocusQuery" json:JSONText(@{@"query" : query})];
      }
      completion:^(NSDictionary *result) {
        NSString *reason = result[@"reason"];
        if (![reason isEqualToString:@"noProvider"] && ![reason isEqualToString:@"stale"]) {
          NSMutableDictionary *payload = [@{@"via" : @"menu", @"shown" : result[@"shown"] ?: @NO} mutableCopy];
          if (reason) payload[@"reason"] = reason;
          if (result[@"panel"]) payload[@"panel"] = result[@"panel"];
          [weakView emit:@"fieldProviderOpened" payload:payload];
        }
        completion(result);
      }];
  return YES;
}

+ (BOOL)showFieldProviderHint:(NSString *)label side:(NSString *)side tab:(NSString *)tabId {
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  ArdiaWebView *view = tab ? [ArdiaTabRegistry viewForTab:tab] : nil;
  NSString *json = PanelHintJSON(label, side);
  if (!view || !json) return NO;
  [view pushFieldProviderHint:json];
  __weak ArdiaWebView *weakView = view;
  [ArdiaWebView whenSystemPanelCloses:^{ [weakView pushFieldProviderHint:@"false"]; }];
  return YES;
}

+ (nullable NSString *)fieldProviderHintJSON:(NSString *)label side:(NSString *)side {
  return PanelHintJSON(label, side);
}

+ (void)whenSystemPanelCloses:(void (^)(void))closed {
  const NSUInteger watch = ++gPanelHintWatch;
  WatchSystemPanelUntilClosed(watch, CACurrentMediaTime(), closed);
}

+ (BOOL)setUpVerificationCode:(NSString *)token tab:(NSString *)tabId generation:(double)generation completion:(void (^)(NSDictionary *result))completion {
  ArdiaCoreTab *tab = ardia_host::TabWithAppTabId(tabId);
  ArdiaWebView *view = tab ? [ArdiaTabRegistry viewForTab:tab] : nil;
  if (!view) return NO;
  NSOrderedSet<NSString *> *frames = [ScriptFramesOf(tab) copy];
  [ArdiaWebView redeemVerificationCode:token
                                 owner:tab
                               profile:view->_profile
                            generation:generation
                            frameAlive:^BOOL(NSString *frame) { return [frames containsObject:frame]; }
                            completion:completion];
  return YES;
}

@end
