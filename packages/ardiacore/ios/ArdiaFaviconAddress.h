#import <CommonCrypto/CommonDigest.h>
#import <Foundation/Foundation.h>

namespace ardia_favicons {

constexpr NSUInteger kTokenLength = 24;
constexpr NSUInteger kRevisionLength = 16;
constexpr NSUInteger kLongestKey = 4096;
constexpr NSUInteger kLargestPNG = 2 * 1024 * 1024;
constexpr uint32_t kLargestSide = 1024;

enum class Kind { none, page, icon };

struct Address {
  NSString *token = nil;
  Kind kind = Kind::none;
  NSString *key = nil;
  NSString *revision = nil;
};

inline NSString *Prefix() {
  return @"ardia-favicon://icon/";
}

inline NSString *KindName(Kind kind) {
  return kind == Kind::page ? @"page" : @"icon";
}

inline bool IsLowerHex(NSString *text, NSUInteger length) {
  if (text.length != length) return false;
  for (NSUInteger i = 0; i < length; i++) {
    const unichar c = [text characterAtIndex:i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

inline NSString *Hex(const uint8_t *bytes, NSUInteger count) {
  NSMutableString *hex = [NSMutableString stringWithCapacity:count * 2];
  for (NSUInteger i = 0; i < count; i++) [hex appendFormat:@"%02x", bytes[i]];
  return hex;
}

inline NSString *RevisionOf(NSData *png) {
  uint8_t digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(png.bytes, (CC_LONG)png.length, digest);
  return Hex(digest, kRevisionLength / 2);
}

inline NSString *Encoded(NSString *key) {
  static NSCharacterSet *unreserved = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"];
  return [key stringByAddingPercentEncodingWithAllowedCharacters:unreserved];
}

inline bool HasNoIcon(NSString *url) {
  static NSRegularExpression *scheme = [NSRegularExpression regularExpressionWithPattern:@"^[a-z][a-z0-9+.-]*:" options:NSRegularExpressionCaseInsensitive error:nil];
  static NSRegularExpression *internal = [NSRegularExpression regularExpressionWithPattern:@"^(?:ardia|ardia-favicon|about|blob|data|javascript):" options:NSRegularExpressionCaseInsensitive error:nil];
  if (![url isKindOfClass:NSString.class] || !url.length || url.length > kLongestKey) return true;
  const NSRange all = NSMakeRange(0, url.length);
  return ![scheme firstMatchInString:url options:0 range:all] || [internal firstMatchInString:url options:0 range:all];
}

inline bool IsWebURL(NSString *url) {
  NSString *scheme = [NSURL URLWithString:url].scheme.lowercaseString;
  return [scheme isEqualToString:@"https"] || [scheme isEqualToString:@"http"];
}

inline bool Addressable(Kind kind, NSString *key) {
  return kind == Kind::page ? !HasNoIcon(key) : kind == Kind::icon && !HasNoIcon(key) && IsWebURL(key);
}

inline NSString *AddressOf(NSString *token, Kind kind, NSString *key, NSString *revision) {
  if (!Addressable(kind, key) || !IsLowerHex(revision, kRevisionLength)) return nil;
  return [NSString stringWithFormat:@"%@%@/%@/%@?v=%@", Prefix(), token, KindName(kind), Encoded(key), revision];
}

inline Address ParseAddress(NSString *address) {
  if (![address isKindOfClass:NSString.class] || ![address hasPrefix:Prefix()] || address.length > kLongestKey * 3 + 128) return {};
  NSArray<NSString *> *parts = [[address substringFromIndex:Prefix().length] componentsSeparatedByString:@"/"];
  if (parts.count != 3 || !IsLowerHex(parts[0], kTokenLength)) return {};
  const Kind kind = [parts[1] isEqualToString:@"page"] ? Kind::page : [parts[1] isEqualToString:@"icon"] ? Kind::icon : Kind::none;
  NSArray<NSString *> *query = [parts[2] componentsSeparatedByString:@"?v="];
  if (kind == Kind::none || query.count != 2 || !IsLowerHex(query[1], kRevisionLength)) return {};
  NSString *key = query[0].stringByRemovingPercentEncoding;
  if (!key || ![Encoded(key) isEqualToString:query[0]] || !Addressable(kind, key)) return {};
  return {parts[0], kind, key, query[1]};
}

inline uint32_t BigEndian(const uint8_t *at) {
  return (uint32_t(at[0]) << 24) | (uint32_t(at[1]) << 16) | (uint32_t(at[2]) << 8) | uint32_t(at[3]);
}

inline bool LooksLikePNG(NSData *data) {
  static const uint8_t signature[] = {0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a};
  static const uint8_t end[] = {0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
  if (![data isKindOfClass:NSData.class] || data.length < 45 || data.length > kLargestPNG) return false;
  const uint8_t *bytes = static_cast<const uint8_t *>(data.bytes);
  if (memcmp(bytes, signature, sizeof signature) != 0 || memcmp(bytes + 12, "IHDR", 4) != 0) return false;
  if (memcmp(bytes + data.length - sizeof end, end, sizeof end) != 0) return false;
  const uint32_t width = BigEndian(bytes + 16), height = BigEndian(bytes + 20);
  return width >= 1 && height >= 1 && width <= kLargestSide && height <= kLargestSide;
}

}
