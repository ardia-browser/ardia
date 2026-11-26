#import <Foundation/Foundation.h>

@class ArdiaCoreTab;

NS_ASSUME_NONNULL_BEGIN

typedef void (^ArdiaPluginWorldMessages)(NSString *world, NSString *document, NSString *json);

@interface ArdiaPluginWorlds : NSObject
- (instancetype)initWithMessages:(ArdiaPluginWorldMessages)messages;
- (void)documentOfTab:(ArdiaCoreTab *)tab completion:(void (^)(NSString *_Nullable document))completion;
- (void)run:(NSString *)world source:(NSString *)source document:(NSString *)document onTab:(ArdiaCoreTab *)tab completion:(void (^)(BOOL ran))completion;
- (void)post:(NSString *)world expression:(NSString *)expression document:(NSString *)document onTab:(ArdiaCoreTab *)tab;
- (void)remove:(NSString *)world teardown:(NSString *)teardown onTab:(ArdiaCoreTab *)tab;
- (void)forgetAll;
@end

NS_ASSUME_NONNULL_END
