#import "ArdiaPictureInPictureInternal.h"

#include <cstdlib>
#include <cstring>

void ACPiPEmit(NSDictionary *event);
uint64_t ACPiPTabIdent(ArdiaCoreTab *tab);

namespace {

const void *const kSourceKey = &kSourceKey;
constexpr NSTimeInterval kQuietHideDelay = 0.3;

BOOL EnvironmentFlag(const char *name) {
  const char *value = getenv(name);
  return value && *value && strcmp(value, "0") != 0;
}

NSHashTable<ACPiPSource *> *LiveSources() {
  static NSHashTable *sources = [NSHashTable weakObjectsHashTable];
  return sources;
}

BOOL WindowSeen(NSWindow *window) {
  if (!window || !window.visible || window.miniaturized) return NO;
  if (ardia_host::Background()) return YES;
  return (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
}

void WatchSight();

}

@implementation ACPiPStamp

+ (instancetype)begin {
  return [[ACPiPStamp alloc] init];
}

- (NSDictionary *)onto:(NSDictionary *)payload {
  return payload ?: @{};
}

@end

@implementation ACPiPLaunch

+ (ACPiPLaunch *)shared {
  static ACPiPLaunch *shared = [[ACPiPLaunch alloc] init];
  return shared;
}

- (BOOL)testInstance {
  return EnvironmentFlag("ARDIA_DATA_DIR") && ardia_host::Background();
}

- (NSString *)dataDirectory {
  const char *value = getenv("ARDIA_DATA_DIR");
  return value && *value ? @(value) : nil;
}

- (NSString *)testValue:(NSString *)name {
  return nil;
}

- (BOOL)traced:(NSString *)name {
  const char *value = getenv("ARDIA_TRACE");
  if (!value || !*value) return NO;
  return [[@(value) componentsSeparatedByString:@","] containsObject:name];
}

@end

@implementation ACPiPSource {
  BOOL _hostShown;
  BOOL _inPictureInPicture;
  NSUInteger _sightTurn;
  NSMutableOrderedSet<NSString *> *_mediaFrames;
}

+ (instancetype)existingForTab:(ArdiaCoreTab *)tab {
  return tab ? objc_getAssociatedObject(tab, kSourceKey) : nil;
}

+ (instancetype)forTab:(ArdiaCoreTab *)tab {
  if (!tab) return nil;
  ACPiPSource *source = [self existingForTab:tab];
  if (source) return source;
  source = [[ACPiPSource alloc] init];
  source.tab = tab;
  source->_seenByUser = NO;
  source->_mediaFrames = [NSMutableOrderedSet orderedSet];
  objc_setAssociatedObject(tab, kSourceKey, source, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
  [LiveSources() addObject:source];
  return source;
}

- (uint64_t)browserId {
  return (uint64_t)(uintptr_t)(__bridge void *)self.tab;
}

- (BOOL)leftAppInPictureInPicture {
  return !NSApp.isActive;
}

- (void)emit:(NSString *)name payload:(NSDictionary *)payload {
  ArdiaCoreTab *tab = self.tab;
  if (!tab) return;
  if ([name isEqualToString:@"activateRequest"]) {
    ACPiPEmit(@{@"event" : @"activation", @"tab" : @(ACPiPTabIdent(tab)), @"reason" : payload[@"reason"] ?: @"pictureInPicture", @"fromOtherApp" : @([payload[@"fromOtherApp"] boolValue])});
    return;
  }
  ACPiPEmit(@{@"event" : @"pipActivity", @"tab" : @(ACPiPTabIdent(tab)), @"name" : name ?: @"", @"payload" : payload ?: @{}});
}

- (void)exitPictureInPicture {
  [self.tab exitPictureInPicture];
}

- (void)noteMediaFrame:(NSString *)frame main:(BOOL)main {
  if (main || !frame.length) return;
  [_mediaFrames addObject:frame];
  while (_mediaFrames.count > 16) [_mediaFrames removeObjectAtIndex:0];
}

- (void)seekPictureInPictureBy:(double)seconds {
  ArdiaCoreTab *tab = self.tab;
  if (!tab) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"action" : @"seekPictureInPictureBy", @"seconds" : @(seconds)} options:0 error:nil];
  NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
  if (!json) return;
  [tab callPage:@"media" json:json];
  for (NSString *frame in _mediaFrames.array)
    if ([tab hasLiveFrame:frame]) [tab callFrame:frame kind:@"media" json:json];
}

- (void)setHostShown:(BOOL)shown {
  _hostShown = shown;
  WatchSight();
  [self reconsiderSight];
}

- (void)setInPictureInPicture:(BOOL)active {
  _inPictureInPicture = active;
}

- (void)reconsiderSight {
  ArdiaCoreTab *tab = self.tab;
  if (!tab) return;
  const BOOL seen = _hostShown && WindowSeen(tab.view.window);
  if (seen == _seenByUser) return;
  _seenByUser = seen;
  const NSUInteger turn = ++_sightTurn;
  if (seen) {
    [tab noteShownByHost:YES];
    if (_inPictureInPicture) {
      ardia_pip::NoteGesture(@"pip exit requested: the user sees the tab again");
      [tab exitPictureInPicture];
    }
    return;
  }
  if (tab.audible || !_hostShown) {
    [tab noteShownByHost:NO];
    return;
  }
  __weak ACPiPSource *weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(kQuietHideDelay * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    ACPiPSource *source = weakSelf;
    if (!source || source->_sightTurn != turn || source->_seenByUser) return;
    [source.tab noteShownByHost:NO];
  });
}

@end

namespace {

void ReconsiderAll() {
  for (ACPiPSource *source in LiveSources().allObjects) [source reconsiderSight];
}

void WatchSight() {
  static BOOL watching;
  if (watching) return;
  watching = YES;
  NSNotificationCenter *center = NSNotificationCenter.defaultCenter;
  for (NSNotificationName name in @[
         NSWindowDidChangeOcclusionStateNotification, NSWindowDidMiniaturizeNotification, NSWindowDidDeminiaturizeNotification,
         NSApplicationDidHideNotification, NSApplicationDidUnhideNotification, NSApplicationDidBecomeActiveNotification,
         NSApplicationDidResignActiveNotification
       ])
    [center addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *) {
      ReconsiderAll();
    }];
}

}

namespace ardia_host {

BOOL Background() {
  static const BOOL background = EnvironmentFlag("ARDIA_BACKGROUND");
  return background;
}

void NotePointer(NSEvent *event, NSString *why) {}

void LogActivation(NSString *what) {
  NSLog(@"[ardia-engine] background: %@", what);
}

void ReconsiderSight(NSWindow *window) {
  for (ACPiPSource *source in LiveSources().allObjects)
    if (!window || source.tab.view.window == window) [source reconsiderSight];
}

}

namespace ardia_pip {

void Install() {
  static BOOL installed;
  if (installed) return;
  installed = YES;
  [ArdiaPiPController installWorkspaceHooks];
  [ArdiaPiPController installPlacementHooks];
}

void NoteHostShown(ArdiaCoreTab *tab, BOOL shown) {
  if (!tab) return;
  [[ACPiPSource forTab:tab] setHostShown:shown];
}

void NoteMediaFrame(ArdiaCoreTab *tab, NSString *frame, BOOL main) {
  [[ACPiPSource existingForTab:tab] noteMediaFrame:frame main:main];
}

void TabChangedPictureInPicture(ArdiaCoreTab *tab, NSDictionary *state) {
  ACPiPSource *source = [ACPiPSource forTab:tab];
  if (!source) return;
  const BOOL active = [state[@"active"] boolValue];
  const BOOL document = [state[@"kind"] isEqual:@"document"];
  [source setInPictureInPicture:active];
  NoteGesture(@"pip %@ kind=%@ by=%@ auto=%d appActive=%d seenByUser=%d", active ? @"opened" : @"closed", document ? @"document" : @"video",
              active ? @"-" : state[@"closedBy"] ?: @"unknown", [state[@"auto"] boolValue], NSApp.isActive, source.seenByUser);
  if (!active) {
    RefreshPinchesFromOtherApps();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_MSEC), dispatch_get_main_queue(), ^{
      RefreshPinchesFromOtherApps();
    });
    return;
  }
  if (document) return DocumentEntered(source, ACPiPStamp.begin);
  WatchZoom();
  VideoEntered(source, [NSURL URLWithString:tab.url ?: @""].host ?: @"", ACPiPStamp.begin);
}

BOOL TabRequestedActivationFor(ArdiaCoreTab *tab, BOOL *fromOtherApp) {
  *fromOtherApp = NO;
  ACPiPSource *source = [ACPiPSource existingForTab:tab];
  return source ? TabRequestedActivation(source, fromOtherApp) : NO;
}

}
