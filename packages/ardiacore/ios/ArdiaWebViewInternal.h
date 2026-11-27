#import "ArdiaInternal.h"
#import "ArdiaWebView.h"
#import "ArdiaNowPlaying.h"
#import "ArdiaTabLifecycle.h"
#include "ArdiaAutoPictureInPictureHold.h"
#include "ArdiaBlankWindowNotes.h"

enum class ArdiaPageFocus { Unknown, Page, DevTools, Elsewhere };

@class ArdiaWebView;

struct ArdiaRequests {
  BOOL loadedOnce{};
  NSString *requestedURL;
};

struct ArdiaSentReports {
  BOOL navigationQueued{};
  NSDictionary *navigation;
  NSString *favicon;
  NSUInteger blockedGeneration{};
  BOOL blockedEmitQueued{};
  CFTimeInterval progressAt{};
  double progress{};
  BOOL progressQueued{};
};

struct ArdiaLeave {
  BOOL active{};
  NSUInteger generation{};
};

struct ArdiaFrameHold {
  BOOL awaiting{};
  NSUInteger generation{};
  NSArray *mark;
  __weak NSView *pane;
  CGFloat paneZ{};
  BOOL holding{};
  __weak ArdiaWebView *holdingFor;
  NSUInteger holdGeneration{};
  __weak ArdiaWebView *tookOverFrom;
  CFTimeInterval tookOverAt{};
};

struct ArdiaStandIn {
  __weak NSView *page;
  ArdiaCoreTab *tab;
  __weak ArdiaWebView *lender;
  BOOL closes{};
  BOOL leaving{};
  float opacity{};
  NSUInteger generation{};
  __weak ArdiaWebView *lentTo;
  CFTimeInterval heldSince{};
  CFTimeInterval lentSince{};
};

enum class ArdiaHeldPageEnd { Painted, Loaded, Pressed, TimedOut, Detached };

struct ArdiaFirstPaint {
  BOOL created{};
  BOOL held{};
  BOOL settled{};
  BOOL coldTab{};
  BOOL scripted{};
  CFTimeInterval heldAt{};
  NSString *heldEpoch{};
  float opacity{};
  NSUInteger generation{};
};

struct ArdiaReveal {
  BOOL active{};
  NSUInteger generation{};
  __weak NSView *loweredPane;
  CGFloat loweredPaneZ{};
  __weak NSView *frontedPage;
  NSUInteger frontGeneration{};
  BOOL native{};
  BOOL onScreen{};
  BOOL painted{};
  NSUInteger press{};
  __weak NSWindow *onScreenIn;
};

struct ArdiaPageReports {
  NSString *theme;
  NSString *themeSource;
  NSInteger blockedCount{};
  NSString *lastBlocked;
  ArdiaNowPlaying *nowPlaying;
  NSMutableDictionary<NSString *, NSString *> *notificationFrames;
  NSMutableDictionary<NSString *, NSDictionary *> *displayRequests;
  double pinchScale{};
  BOOL capturing{};
  BOOL crashed{};
  NSMutableSet<NSString *> *exclusiveFrames;
  BOOL seenByUser{YES};
  BOOL inPictureInPicture{};
  BOOL autoPictureInPictureActive{};
  BOOL keptByWindowServer{};
  BOOL playedForAutoPictureInPicture{};
  ardia_auto_pip::Hold autoPictureInPictureHold;
  NSUInteger autoPictureInPictureWatch{};
};

struct ArdiaCommits {
  __weak ArdiaCoreTab *tab;
  NSString *url;
  double at{};
  int httpStatus{};
  int documents{};
};

struct ArdiaElementPick {
  __weak ArdiaCoreTab *tab;
  int documents{};
  double armed{};
  BOOL input{};
  NSPoint menuPoint{};
  CFTimeInterval menuAt{-1};
  __weak ArdiaCoreTab *menuTab;
};

struct ArdiaFocusAsk {
  BOOL asked{};
  BOOL onlyIfUnfocused{};
  __weak ArdiaCoreTab *tab;
};

struct ArdiaPageFocusState {
  ArdiaPageFocus page{ArdiaPageFocus::Unknown};
  __weak NSView *devTools;
  __weak NSView *elsewhere;
  BOOL onActivate{};
  BOOL keepsOutgoing{};
  ArdiaFocusAsk askedAheadOfSwitch;
  CFTimeInterval activatedAt{};
  __weak NSWindow *activatedIn;
};

@class ArdiaConsentStamp;

@interface ArdiaWebView () <ArdiaCoreTabDelegate> {
  __weak id<ArdiaWebViewDelegate> _delegate;
  ArdiaTabLifecycle _life;
  ArdiaRequests _requests;
  ArdiaSentReports _sent;
  ArdiaLeave _leave;
  ArdiaFrameHold _frameHold;
  void (^_swapReport)(BOOL heldTimedOut);
  CFTimeInterval _swapReportAt;
  ArdiaStandIn _standIn;
  ArdiaFirstPaint _firstPaint;
  ArdiaReveal _reveal;
  ArdiaPageFocusState _focus;
  ArdiaPageReports _reports;
  ArdiaCommits _commits;
  NSString *_profile;
  NSString *_initialURL;
  NSString *_adoptId;
  NSString *_transferKey;
  BOOL _standalone;
  BOOL _temporary;
  NSString *_temporarySource;
  NSString *_extensionHost;
  NSColor *_pageBackgroundColor;
  NSColor *_contentsBackgroundColor;
  NSString *_pageColor;
  NSString *_shownURL;
  BOOL _visible;
  BOOL _selected;
  BOOL _warm;
  BOOL _neighbour;
  BOOL _autoPictureInPicture;
  ArdiaConsentStamp *_pictureInPictureRequestStamp;
  BOOL _frozen;
  ArdiaCoreTab *_tab;
  BOOL _muted;
  NSInteger _tabIndex;
  BOOL _pinned;
  NSView *_devtoolsView;
  CFTimeInterval _linkDropAt;
  CFTimeInterval _autoplayBlockedAt;
  NSMutableDictionary<NSString *, NSNumber *> *_trustedInputAt;
  ArdiaElementPick _elementPick;
  NSMutableArray<NSDictionary<NSString *, id> *> *_newTabLinks;
  ardia_blank_window_notes::Pairing _blankWindowNotes;
  id _sightObserver;
  id _interfaceScaleObserver;
}
- (ArdiaWindowController *)controller;
- (void)notePageMetrics:(NSDictionary *)metrics main:(BOOL)main;
- (void)sendMetricsGenerationTo:(NSString *)frameId;
- (void)emit:(NSString *)name payload:(NSDictionary *)payload;
@end

typedef NS_ENUM(NSInteger, ArdiaTransfer) {
  ArdiaTransferNone,
  ArdiaTransferTaken,
  ArdiaTransferHeld,
};

@interface ArdiaWebView (TransferInternal)
+ (BOOL)keepTransfersOfWindow:(NSWindow *)window;
+ (void)retryPagesInWindow:(ArdiaWindowController *)controller;
- (void)waitForWindow;
- (BOOL)takeLinkTab:(NSString *)adoptId;
- (void)ensureTab;
- (BOOL)cloneTab:(NSString *)sourceKey profile:(ArdiaCoreProfile *)profile;
- (BOOL)canTake:(ArdiaCoreTab *)tab;
- (ArdiaTransfer)takeTransferredTab;
- (void)bindRestoreKey;
- (void)forgetRestoreKey;
@end

@interface ArdiaWebView (TabInternal)
- (ArdiaCoreAdoption)adoptIntoWindow;
- (ArdiaCoreAdoption)windowTakes:(ArdiaCoreTab *)tab;
- (void)adoptMovedPage;
- (BOOL)holdTransferOf:(ArdiaCoreTab *)tab;
- (void)attach:(ArdiaCoreTab *)tab;
- (void)detach;
@property(nonatomic, readonly) NSString *keptFromUnloadingBy;
- (BOOL)unloadKeepingHistory;
- (void)stashPageReports;
- (void)takePageReports;
- (void)placeTab;
- (void)openedTab:(ArdiaCoreTab *)tab adoptId:(NSString *)adoptId disposition:(NSString *)disposition;
- (void)openedLinkTab:(ArdiaCoreTab *)tab adoptId:(NSString *)adoptId disposition:(NSString *)disposition;
- (void)openedPopupTab:(ArdiaCoreTab *)tab;
- (BOOL)opensPopupsAsTabs;
- (void)announceOpenedTab:(ArdiaCoreTab *)tab
                  adoptId:(NSString *)adoptId
              disposition:(NSString *)disposition
                     link:(BOOL)link
                    tries:(int)tries;
- (void)noteNewTabLink:(nullable NSString *)url blankWindow:(BOOL)blankWindow;
- (void)tabRemovedFromWindow:(ArdiaCoreWindow *)window;
- (void)tabActivatedByChrome:(BOOL)chromes;
- (void)devToolsChanged:(NSView *)devToolsView;
- (void)dropDevTools;
@end

@interface ArdiaWebView (PaintingInternal)
+ (void)sleepNeighbourPagesIn:(NSWindow *)window after:(CFTimeInterval)delay;
+ (void)repaintWarmPagesIn:(NSWindow *)window;
+ (void)noteShown:(ArdiaCoreTab *)tab;
+ (void)drainPainting;
- (void)layoutPage;
- (void)interfaceScaleChanged;
- (BOOL)paints;
- (BOOL)neighbourPageAsleep;
- (void)applyPainting;
- (void)markTemporary;
- (BOOL)seenByUser;
- (BOOL)userBackOnTab;
- (void)userSightChanged;
- (void)schedulePainting;
- (void)leaveScreen;
- (void)beginFrameHoldIfCold;
- (void)exposePage;
- (BOOL)releasePageForOffscreen;
- (void)reportSwapShown:(void (^)(BOOL heldTimedOut))report;
- (void)finishFrameHold;
- (void)stopHolding;
- (void)takeFocusFromLingeringPane;
@end

@interface ArdiaWebView (FirstPaintInternal)
- (void)holdPageUntilPainted:(BOOL)created;
- (void)holdCreatedPageShown;
- (void)showHeldPage:(ArdiaHeldPageEnd)end;
- (void)showHeldPageOnNextFrame;
- (void)showHeldPageAfterLoad;
@end

@interface ArdiaWebView (StandInInternal)
- (void)lendPageToSuccessor;
- (void)reclaimLentPage;
- (BOOL)closesLentTab:(ArdiaCoreTab *)tab;
- (void)dropStandIn;
- (void)finishStandIn;
@end

@interface ArdiaWebView (FocusInternal)
+ (ArdiaWebView *)holding:(id)responder;
- (void)storePageFocus;
- (void)storePageFocusFrom:(NSResponder *)responder;
- (void)requestFocusRestore;
- (void)requestFocusRestoreIn:(NSWindow *)window;
- (void)restoreFocusIfDue;
- (BOOL)focusRememberedDevToolsIn:(NSWindow *)window;
- (void)focusAfterLingeringPane;
- (void)settleFirstShowFocus;
- (void)focusAfterLoad;
@end

@interface ArdiaWebView (RevealsInternal)
+ (void)dropRevealsInWindow:(NSWindow *)window except:(ArdiaWebView *)keep;
+ (void)dropRevealsInWindow:(NSWindow *)window pressedBy:(NSUInteger)press;
+ (BOOL)replaceRevealsInWindow:(NSWindow *)window with:(ArdiaWebView *)pressed;
+ (void)takeBackPressesUnheardUpTo:(NSUInteger)press;
- (BOOL)onlyShownInWindow;
- (void)frontPage:(NSView *)page profile:(ArdiaCoreProfile *)profile;
- (void)dropFront;
- (BOOL)revealsFirst;
- (ArdiaWebView *)revealableOver:(BOOL)pastOtherReveals;
+ (ArdiaWebView *)nativeRevealInWindow:(NSWindow *)window except:(ArdiaWebView *)skip;
- (BOOL)stayOver:(ArdiaWebView *)shown;
- (void)revealAhead;
- (void)endReveal;
- (void)dropReveal;
- (void)paintAfterReveal:(BOOL)native;
- (void)settleRevealsInWindow;
@end

@interface ArdiaWebView (RevealInput)
+ (ArdiaWebView *)onScreenAheadIn:(NSWindow *)window;
+ (BOOL)anyRevealGap;
+ (BOOL)swallowsAheadOfSwitch:(NSEvent *)event;
+ (BOOL)skipsEventMonitors:(NSEvent *)event;
+ (void)revealGapChangedIn:(NSWindow *)window;
- (void)noteOnScreenAhead:(BOOL)overAnother;
- (void)settleOnScreenAhead;
- (void)leaveScreenAheadOnceGone;
- (void)leaveScreenAhead;
- (void)acceptDropsIfShown;
- (void)askFocusAheadOfSwitch:(BOOL)onlyIfUnfocused;
+ (void)focusPagesAskedAheadOfSwitch;
- (void)hidePageIdentity;
- (void)hidePageIdentityAfterMount;
@end

@interface ArdiaWebView (PageMessagesInternal)
- (void)noteScriptFrame:(NSString *)frameId main:(BOOL)main sameSite:(BOOL)sameSite;
- (void)forgetScriptFrame:(NSString *)frameId;
- (void)pushSelectionPopover;
- (void)pushFieldProvider;
- (void)pushFieldProviderHint:(NSString *)json;
- (BOOL)sameSiteFrame:(BOOL)main origin:(NSString *)origin;
- (void)callFrame:(NSString *)frameId kind:(NSString *)kind json:(NSString *)json;
- (void)resetPageMedia;
- (nullable NSNumber *)trustedInputAgeMsForOrigin:(NSString *)origin;
@end

@interface ArdiaWebView (PeekInternal)
- (void)pushPeekModifier;
- (BOOL)peeksLinksToOtherSites;
- (void)fallBackFromPeek:(NSDictionary *)dict url:(NSString *)url frame:(NSString *)frameId reason:(NSString *)reason test:(BOOL)test;
- (void)peekLink:(NSDictionary *)dict frame:(NSString *)frameId main:(BOOL)main;
@end

@interface ArdiaWebView (PictureInPictureInternal)
- (void)traceManualPictureInPicture:(NSString *)what;
- (void)traceAutoPictureInPicture:(NSString *)what;
- (void)notePictureInPictureSight:(NSString *)what;
- (void)awaitPictureInPicture:(int)tries completion:(void (^)(BOOL))completion;
- (void)updateAutoPictureInPicture;
- (void)holdAutoPictureInPictureAfterEnd:(BOOL)appAsked;
- (BOOL)leftAppInPictureInPicture;
- (BOOL)playsForAutoPictureInPicture;
- (void)autoPictureInPictureInputsChanged;
- (void)noteStayedOnAppSwitch;
+ (BOOL)playsForAutoPictureInPictureInWindow:(NSWindow *)window;
@end

@interface ArdiaWebView (NavigationInternal)
- (void)emitNavigation;
- (void)queueNavigation;
- (NSString *)committedURL;
- (void)followCommitsOfTab;
- (void)resetBlocked:(BOOL)report;
- (void)sendProgress;
- (void)loadNow:(NSString *)url userInitiated:(BOOL)userInitiated;
- (BOOL)skipsNavigationDownload:(NSString *)url userInitiated:(BOOL)userInitiated;
@end

@interface ArdiaWebView (PageCommandsInternal)
- (void)emitMedia;
- (void)emitZoom;
- (void)runChromeCommand:(int)command;
- (void)thawHiddenPage;
- (BOOL)awaitsFirstDocument;
@end

@interface ArdiaWebView (InputMonitorsInternal)
+ (BOOL)prewarmForMouseEvent:(NSEvent *)event;
- (BOOL)canWakeFrames;
- (void)commandWheelFromPage:(NSDictionary *)reply;
@end

namespace ardia_web_view {

constexpr CFTimeInterval kNeighbourPagesAwakeSeconds = 10;

bool TraceVisibility();
NSHashTable<ArdiaWebView *> *LiveViews();
bool SamePage(NSString *a, NSString *b);
NSString *OriginOf(NSString *url);
NSString *VerifiedOrigin(NSString *origin);
NSDictionary *_Nullable FieldProviderFor(NSString *_Nullable profile);
NSString *FieldProviderJSON(NSString *_Nullable profile);
void NoteEvent(int browserId, NSString *name, NSDictionary *payload);
void AcceptDrops(NSView *root, BOOL accept);
NSView *PaneUnder(NSView *view, NSView *ancestor);
NSView *SharedAncestor(NSView *a, NSView *b);
NSView *HitInWindow(NSEvent *event);
extern const NSEventMask kRevealInputMask;
NSString *ReactTagOf(NSView *view);
NSView *RenderWidgetIn(NSView *page);
NSArray *FrameMarkOf(NSView *widget);

template <typename T>
T *Field(NSDictionary *d, NSString *key) {
  id value = d[key];
  return [value isKindOfClass:[T class]] ? value : nil;
}

NSString *Text(NSDictionary *d, NSString *key, NSUInteger max);
bool Flag(NSDictionary *d, NSString *key);
bool Finite(NSDictionary *d, NSString *key, double *out);

void AnswerHello(ArdiaCoreTab *tab, NSString *profile, NSString *frameId, BOOL main, NSString *verifiedOrigin);
NSMutableOrderedSet<NSString *> *ScriptFramesOf(ArdiaCoreTab *tab);

extern NSString *gPeekModifier;
void InstallPeekMonitor();
BOOL PeekTracing();
void PeekTrace(NSDictionary *entry);
NSString *SplitLinkModifier();
NSString *PeekConfigJSON(ArdiaWebView *view);
NSDictionary *_Nullable RecentClickPoint(ArdiaWebView *view);

NSPoint RootPointFromWindow(NSWindow *window, NSPoint inWindow);
NSRect RootRectFromWindow(NSWindow *window, NSRect inWindow);
CGFloat RootPointsPerLocalPoint(NSView *view);
BOOL MayHoldUserActivation(NSWindow *window);
BOOL TakeShiftClick(ArdiaWebView *view);

void InstallControlPressMonitor();
BOOL TracingPictureInPicture();

}
