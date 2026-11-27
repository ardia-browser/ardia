#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

NS_SWIFT_NAME(LaunchConfig)
@interface ArdiaLaunchConfig : NSObject

@property(class, readonly) ArdiaLaunchConfig *shared;

- (instancetype)initWithEnvironment:(NSDictionary<NSString *, NSString *> *)environment
                          arguments:(NSArray<NSString *> *)arguments
                      homeDirectory:(NSString *)homeDirectory
              signedForDistribution:(BOOL (^)(void))signedForDistribution NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@property(readonly, nullable) NSString *dataDirectory;
@property(readonly) NSString *configDirectory;
@property(readonly) BOOL background;
@property(readonly, nullable) NSNumber *remoteDebuggingPort;
@property(readonly) BOOL prewarm;
@property(readonly, nullable) NSString *feedbackURL;
@property(readonly) BOOL isolated;
@property(readonly) BOOL testInstance;
@property(readonly) BOOL webUIShell;
@property(readonly) BOOL webUIDataDirectoryDefaulted;
@property(readonly, nullable) NSString *webUIHostApp;
@property(readonly) BOOL webUIHandedOff;
@property(readonly) BOOL webUIRefusedDataDirectory;

- (nullable NSString *)instance:(NSString *)key NS_SWIFT_NAME(instance(_:));
- (BOOL)instanceFlag:(NSString *)key NS_SWIFT_NAME(instanceFlag(_:));
- (BOOL)switchOn:(NSString *)name NS_SWIFT_NAME(switchOn(_:));
- (BOOL)experimentOn:(NSString *)name NS_SWIFT_NAME(experimentOn(_:));
- (BOOL)traced:(NSString *)area NS_SWIFT_NAME(traced(_:));
- (nullable NSString *)testValue:(NSString *)key NS_SWIFT_NAME(testValue(_:));
- (BOOL)testFlag:(NSString *)key NS_SWIFT_NAME(testFlag(_:));

@property(readonly) NSArray<NSString *> *engineSwitches;
@property(readonly) NSDictionary<NSString *, NSString *> *environmentForChildProcesses;
@property(readonly) NSDictionary<NSString *, id> *snapshot;

@end

NS_ASSUME_NONNULL_END
