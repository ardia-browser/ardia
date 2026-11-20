#import "ArdiaWebView.h"

NS_ASSUME_NONNULL_BEGIN

extern NSString *const ArdiaVaultLoadingTitle;
extern NSString *const ArdiaVaultUnlockTitle;
constexpr NSUInteger kArdiaVaultLongestValue = 4096;

NSUInteger ArdiaVaultContextIndex(NSArray<NSString *> *titles);
NSArray<NSString *> *ArdiaVaultFieldKinds();
bool ArdiaVaultSecureOrigin(NSString *_Nullable origin);
NSDictionary *_Nullable ArdiaVaultRect(NSDictionary *_Nullable rect);
NSInteger ArdiaVaultMaxLength(NSDictionary *d);
NSArray<NSString *> *ArdiaVaultMenuPath(NSString *pick);
NSDictionary *ArdiaVaultMenuModel(NSDictionary *menu, NSDictionary *_Nullable (*login)(NSDictionary *_Nullable value));
NSMenu *ArdiaVaultSubmenu(NSString *title);
NSMenuItem *ArdiaVaultMenuNote(NSString *title);
NSMenuItem *ArdiaVaultMenuChoice(NSString *title, id target, NSDictionary *action);

@interface ArdiaWebView (VaultContextMenuInternal)
- (void)noteVaultContext:(NSDictionary *)dict frame:(NSString *)frameId main:(BOOL)main origin:(nullable NSString *)origin;
- (NSArray<NSMenuItem *> *)takeVaultContextMenuItems;
+ (void)ensureVaultContextMenuHook;
- (BOOL)pickVaultContextMenu:(NSString *)pick redump:(void (^)(NSArray<NSDictionary *> *described))redump;
- (NSArray<NSDictionary *> *)describeVaultContextItems:(NSArray<NSMenuItem *> *)items;
@end

NS_ASSUME_NONNULL_END
