#import "ArdiaLoginListReport.h"

#include <cmath>

namespace {

const NSUInteger kTypedMax = 200;
const NSUInteger kTokenMax = 16;
const double kCoordinateMax = 1e6;

NSString *Choice(NSDictionary *d, NSString *key, NSArray<NSString *> *choices) {
  id value = d[key];
  return [value isKindOfClass:NSString.class] && [choices containsObject:value] ? value : nil;
}

double Coordinate(NSDictionary *d, NSString *key) {
  id value = d[key];
  if (![value isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) return 0;
  const double number = [value doubleValue];
  return std::isfinite(number) ? MAX(-kCoordinateMax, MIN(kCoordinateMax, number)) : 0;
}

NSString *Typed(NSDictionary *d) {
  id value = d[@"typed"];
  if (![value isKindOfClass:NSString.class]) return @"";
  NSString *typed = value;
  if (typed.length <= kTypedMax) return typed;
  return [typed substringToIndex:[typed rangeOfComposedCharacterSequenceAtIndex:kTypedMax].location];
}

}

NSString *ArdiaLoginListTicket(id value) {
  if (![value isKindOfClass:NSString.class]) return nil;
  NSString *token = value;
  if (!token.length || token.length > kTokenMax) return nil;
  for (NSUInteger i = 0; i < token.length; i++) {
    const unichar c = [token characterAtIndex:i];
    if (c < '0' || c > '9') return nil;
  }
  return token;
}

NSDictionary *ArdiaLoginListReport(id message) {
  if (![message isKindOfClass:NSDictionary.class]) return nil;
  NSDictionary *d = message;
  NSString *event = Choice(d, @"event", @[ @"show", @"input", @"key", @"hide", @"passwordInput" ]);
  if ([event isEqualToString:@"hide"]) return @{@"event" : event};
  NSString *token = ArdiaLoginListTicket(d[@"token"]);
  if (!event || !token) return nil;
  if ([event isEqualToString:@"passwordInput"]) return @{@"event" : event, @"token" : token};
  if ([event isEqualToString:@"key"]) {
    NSString *key = Choice(d, @"key", @[ @"down", @"up", @"enter", @"escape", @"tab" ]);
    return key ? @{@"event" : event, @"token" : token, @"key" : key} : nil;
  }
  NSString *field = Choice(d, @"field", @[ @"username", @"password", @"code" ]);
  if (!field) return nil;
  const NSRect rect = NSMakeRect(Coordinate(d, @"x"), Coordinate(d, @"y"), MAX(1, Coordinate(d, @"width")), MAX(1, Coordinate(d, @"height")));
  return @{
    @"event" : event,
    @"token" : token,
    @"field" : field,
    @"typed" : [field isEqualToString:@"username"] ? Typed(d) : @"",
    @"rect" : [NSValue valueWithRect:rect],
  };
}
