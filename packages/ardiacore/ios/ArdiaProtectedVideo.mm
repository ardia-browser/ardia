#import "ArdiaProtectedVideoInternal.h"

#import "ArdiaLaunchConfig.h"

using namespace ardia_runtime;
using namespace ardia_web_view;
using namespace ardia_protected_video;

namespace {

NSString *const kScriptOff = @"const PROTECTED_VIDEO_ON = false;";
NSString *const kScriptOn = @"const PROTECTED_VIDEO_ON = true;";
NSString *const kOriginsOff = @"const PROTECTED_VIDEO_ORIGINS = [\"https://www.netflix.com\", \"https://www.disneyplus.com\"];";
NSString *const kExtensionName = @"protected-video-ua";
NSString *const kTestOriginPrefix = @"http://127.0.0.1:";
constexpr NSTimeInterval kReloadGap = 5;
constexpr NSTimeInterval kRulesSettle = 1;
NSString *const kUserAgentRuleOrigin = @"https://www.netflix.com";
BOOL gEnabled = NO;
NSString *gOriginalScript;

NSString *TestOrigin() {
  static NSString *origin = ^NSString * {
    NSString *value = [ArdiaLaunchConfig.shared testValue:@"protectedVideoOrigin"];
    if (![value hasPrefix:kTestOriginPrefix]) return nil;
    NSString *port = [value substringFromIndex:kTestOriginPrefix.length];
    const NSInteger number = port.integerValue;
    return port.length && port.length <= 5 && [port isEqualToString:@(number).stringValue] && number > 0 && number < 65536 ? value : nil;
  }();
  return origin;
}

NSSet<NSString *> *ProtectedVideoOrigins() {
  static NSSet<NSString *> *origins = ^NSSet<NSString *> * {
    NSMutableSet *set = [NSMutableSet setWithArray:@[ @"https://www.netflix.com", @"https://www.disneyplus.com" ]];
    if (NSString *test = TestOrigin()) [set addObject:test];
    return set;
  }();
  return origins;
}

}

@implementation ArdiaProtectedVideo

+ (NSMapTable<ArdiaCoreTab *, ArdiaPVSession *> *)sessions {
  static NSMapTable *sessions = [NSMapTable weakToStrongObjectsMapTable];
  return sessions;
}

+ (NSMapTable<ArdiaCoreProfile *, NSString *> *)extensions {
  static NSMapTable *extensions = [NSMapTable weakToStrongObjectsMapTable];
  return extensions;
}

+ (NSMapTable<ArdiaCoreProfile *, NSDate *> *)extensionLoads {
  static NSMapTable *loads = [NSMapTable weakToStrongObjectsMapTable];
  return loads;
}

+ (BOOL)enabled {
  return gEnabled;
}

+ (void)setEnabled:(BOOL)enabled {
  if (enabled == gEnabled) return;
  gEnabled = enabled;
  if (gOriginalScript) ArdiaCoreEngine.sharedEngine.pageScript = [self bakedScript];
  for (ArdiaCoreProfile *profile in ardia_host::LoadedProfiles()) {
    if (enabled) [self loadIntoProfile:profile];
    else if (NSString *extensionId = [self.extensions objectForKey:profile]) [profile unloadComponentExtension:extensionId];
  }
  if (!enabled) {
    [self.extensions removeAllObjects];
    [self.extensionLoads removeAllObjects];
    for (ArdiaPVSession *session in self.sessions.objectEnumerator.allObjects) [session close];
    [self.sessions removeAllObjects];
  }
}

+ (NSString *)bakedScript {
  if (!gEnabled) return gOriginalScript;
  NSString *script = [gOriginalScript stringByReplacingOccurrencesOfString:kScriptOff withString:kScriptOn];
  if (NSString *test = TestOrigin()) {
    NSString *origins = [kOriginsOff stringByReplacingOccurrencesOfString:@"];" withString:[NSString stringWithFormat:@", \"%@\"];", test]];
    script = [script stringByReplacingOccurrencesOfString:kOriginsOff withString:origins];
  }
  return script;
}

+ (NSString *)pageScriptFrom:(NSString *)script {
  gOriginalScript = [script copy];
  return [self bakedScript];
}

+ (void)loadIntoProfile:(ArdiaCoreProfile *)profile {
  if (!gEnabled || !profile || profile.offTheRecord || [self.extensions objectForKey:profile]) return;
  NSString *path = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:[@"Extensions" stringByAppendingPathComponent:kExtensionName]];
  if (![NSFileManager.defaultManager fileExistsAtPath:[path stringByAppendingPathComponent:@"manifest.json"]]) return;
  NSString *extensionId = [profile loadComponentExtension:path];
  Trace(@"user agent extension in %@: %@", profile.name, extensionId ?: @"not loaded");
  if (!extensionId) return;
  [self.extensions setObject:extensionId forKey:profile];
  [self.extensionLoads setObject:NSDate.date forKey:profile];
}

+ (BOOL)servesOrigin:(NSString *)origin {
  return origin && [ProtectedVideoOrigins() containsObject:origin];
}

+ (NSMapTable<ArdiaCoreTab *, NSDate *> *)reloads {
  static NSMapTable *reloads = [NSMapTable weakToStrongObjectsMapTable];
  return reloads;
}

+ (NSTimeInterval)rulesSettleForTab:(ArdiaCoreTab *)tab origin:(NSString *)origin started:(NSTimeInterval)started {
  if (!gEnabled || started <= 0 || ![origin isEqualToString:kUserAgentRuleOrigin]) return 0;
  NSDate *loaded = tab.profile ? [self.extensionLoads objectForKey:tab.profile] : nil;
  const NSTimeInterval settled = loaded.timeIntervalSince1970 + kRulesSettle;
  return loaded && started < settled ? settled : 0;
}

+ (void)helloFromTab:(ArdiaCoreTab *)tab origin:(NSString *)origin bridged:(BOOL)bridged started:(NSTimeInterval)started {
  if (!tab || ![self servesOrigin:origin]) return;
  const NSTimeInterval settled = [self rulesSettleForTab:tab origin:origin started:started];
  if (bridged == gEnabled && !settled) return;
  NSDate *last = [self.reloads objectForKey:tab];
  if (last && -last.timeIntervalSinceNow < kReloadGap) return;
  [self.reloads setObject:NSDate.date forKey:tab];
  if (settled) Trace(@"reload: the page started before its user agent rules");
  else Trace(@"reload: the page started with the bridge %@", bridged ? @"on" : @"off");
  const NSTimeInterval wait = MAX(0, settled - NSDate.date.timeIntervalSince1970);
  __weak ArdiaCoreTab *weakTab = tab;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(wait * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ArdiaCoreTab *current = weakTab;
    if (current && [OriginOf(current.url) isEqualToString:origin]) [current reload];
  });
}

+ (void)tab:(ArdiaCoreTab *)tab frame:(NSString *)frameId message:(NSDictionary *)message {
  if (!gEnabled || !frameId.length) return;
  ArdiaPVSession *session = [self.sessions objectForKey:tab];
  if (session && ![session.frame isEqualToString:frameId]) {
    [session close];
    session = nil;
  }
  if (!session) {
    session = [[ArdiaPVSession alloc] initWithTab:tab frame:frameId];
    [self.sessions setObject:session forKey:tab];
  }
  [session handle:message];
}

+ (void)pageGoneFromTab:(ArdiaCoreTab *)tab {
  if (!tab) return;
  ArdiaPVSession *session = [self.sessions objectForKey:tab];
  if (!session) return;
  [self.sessions removeObjectForKey:tab];
  [session close];
}

+ (void)muteChangedInTab:(ArdiaCoreTab *)tab {
  if (tab) [[self.sessions objectForKey:tab] muteChanged];
}

+ (BOOL)activeInTab:(ArdiaCoreTab *)tab {
  return tab && [[self.sessions objectForKey:tab] active];
}

+ (BOOL)playsInTab:(ArdiaCoreTab *)tab {
  return tab && [[self.sessions objectForKey:tab] plays];
}

+ (BOOL)startPictureInPictureInTab:(ArdiaCoreTab *)tab {
  return [[self.sessions objectForKey:tab] startPictureInPicture];
}

+ (void)exitPictureInPictureInTab:(ArdiaCoreTab *)tab {
  if (tab) [[self.sessions objectForKey:tab] exitPictureInPicture];
}

@end
