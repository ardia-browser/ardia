#pragma once

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>

#import "ArdiaCore.h"

NS_ASSUME_NONNULL_BEGIN

@interface ACPiPStamp : NSObject
+ (instancetype)begin;
- (NSDictionary *)onto:(NSDictionary *)payload;
@end

@interface ACPiPSource : NSObject
@property(nonatomic, weak, nullable) ArdiaCoreTab *tab;
@property(nonatomic, readonly) uint64_t browserId;
@property(nonatomic) BOOL seenByUser;
+ (nullable instancetype)forTab:(nullable ArdiaCoreTab *)tab;
+ (nullable instancetype)existingForTab:(nullable ArdiaCoreTab *)tab;
- (BOOL)leftAppInPictureInPicture;
- (void)emit:(NSString *)name payload:(nullable NSDictionary *)payload;
- (void)exitPictureInPicture;
- (void)seekPictureInPictureBy:(double)seconds;
- (void)noteMediaFrame:(NSString *)frame main:(BOOL)main;
- (void)setHostShown:(BOOL)shown;
- (void)setInPictureInPicture:(BOOL)active;
- (void)reconsiderSight;
@end

@interface ACPiPLaunch : NSObject
@property(class, readonly) ACPiPLaunch *shared;
@property(nonatomic, readonly) BOOL testInstance;
@property(nonatomic, readonly, nullable) NSString *dataDirectory;
- (nullable NSString *)testValue:(NSString *)name;
- (BOOL)traced:(NSString *)name;
@end

NS_ASSUME_NONNULL_END

namespace ardia_host {

BOOL Background();
void NotePointer(NSEvent *_Nullable event, NSString *_Nonnull why);
void LogActivation(NSString *_Nonnull what);
void ReconsiderSight(NSWindow *_Nullable window);

}

namespace ardia_runtime {

inline bool ReplaceMethod(Class _Nullable cls, SEL _Nonnull sel, id _Nonnull (^_Nonnull make)(IMP _Nonnull original)) {
  Method method = cls ? class_getInstanceMethod(cls, sel) : nullptr;
  if (!method) return false;
  const IMP ours = imp_implementationWithBlock(make(method_getImplementation(method)));
  if (!class_addMethod(cls, sel, ours, method_getTypeEncoding(method))) method_setImplementation(method, ours);
  return true;
}

}

inline NSView *_Nullable ArdiaWindowRootView(NSWindow *_Nullable window) { return window.contentView; }

inline BOOL ACPiPIsChromeFramelessWindow(NSWindow *_Nullable window) {
  Class core = NSClassFromString(@"ArdiaCoreWindow");
  return window && core && [core respondsToSelector:@selector(isChromeFramelessWindow:)] && [core isChromeFramelessWindow:(NSWindow *_Nonnull)window];
}

namespace ardia_pip {

void WatchZoom();
void RefreshPinchesFromOtherApps();
NSWindow *_Nullable GrabbedWindow();
void VideoEntered(ACPiPSource *_Nonnull view, NSString *_Nonnull host, ACPiPStamp *_Nonnull stamp);
void DocumentEntered(ACPiPSource *_Nonnull view, ACPiPStamp *_Nonnull stamp);
BOOL TabRequestedActivation(ACPiPSource *_Nonnull view, BOOL *_Nonnull fromOtherApp);
void Install();
void NoteHostShown(ArdiaCoreTab *_Nullable tab, BOOL shown);
void NoteMediaFrame(ArdiaCoreTab *_Nullable tab, NSString *_Nonnull frame, BOOL main);
void TabChangedPictureInPicture(ArdiaCoreTab *_Nonnull tab, NSDictionary *_Nonnull state);
BOOL TabRequestedActivationFor(ArdiaCoreTab *_Nonnull tab, BOOL *_Nonnull fromOtherApp);

}
