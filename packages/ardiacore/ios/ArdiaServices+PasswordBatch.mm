#import "ArdiaServices.h"

#import "ArdiaEngineBridge.h"
#import "ArdiaInternal.h"

namespace {

NSString *HexOf(NSString *text) {
  NSData *bytes = [text dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  NSMutableString *hex = [NSMutableString stringWithCapacity:bytes.length * 2];
  const unsigned char *raw = (const unsigned char *)bytes.bytes;
  for (NSUInteger i = 0; i < bytes.length; i++) [hex appendFormat:@"%02x", raw[i]];
  return hex;
}

}

@implementation ArdiaServices (PasswordBatch)

+ (void)savePasswords:(NSString *)profile json:(NSString *)json reply:(ArdiaServiceReply)reply {
  id parsed = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data] options:0 error:nil];
  if (![parsed isKindOfClass:NSArray.class]) return reply(nil, @"bad arguments");
  NSMutableArray *entries = [NSMutableArray arrayWithCapacity:[parsed count]];
  for (NSDictionary *login in parsed) {
    if (![login isKindOfClass:NSDictionary.class] || ![login[@"origin"] isKindOfClass:NSString.class] || ![login[@"password"] isKindOfClass:NSString.class]) return reply(nil, @"bad arguments");
    NSMutableDictionary *entry = [@{@"origin" : login[@"origin"], @"passwordHex" : HexOf(login[@"password"])} mutableCopy];
    if ([login[@"username"] isKindOfClass:NSString.class]) entry[@"username"] = login[@"username"];
    if ([login[@"note"] isKindOfClass:NSString.class]) entry[@"note"] = login[@"note"];
    [entries addObject:entry];
  }
  NSData *args = [NSJSONSerialization dataWithJSONObject:@{@"entries" : entries} options:0 error:nil];
  if (!args) return reply(nil, @"bad arguments");
  [ArdiaEngineBridge callWithSecret:@"ac_passwords_add_many"
                            profile:ardia_host::OriginalProfileName(profile)
                               args:[args mutableCopy]
                         completion:^(NSString *answer) {
                           id result = [NSJSONSerialization JSONObjectWithData:[answer dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data] options:0 error:nil];
                           if (![result isKindOfClass:NSDictionary.class]) return reply(nil, @"bad reply from the engine");
                           if (id error = result[@"error"]) return reply(nil, [error description]);
                           reply(result, nil);
                         }];
}

@end
