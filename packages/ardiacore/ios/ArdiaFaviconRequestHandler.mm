#import <React/RCTBridgeModule.h>
#import <React/RCTURLRequestHandler.h>

#import "ArdiaFaviconSessions.h"

@interface ArdiaFaviconRequestHandler : NSObject <RCTURLRequestHandler>
@end

@implementation ArdiaFaviconRequestHandler

RCT_EXPORT_MODULE()

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

- (BOOL)canHandleRequest:(NSURLRequest *)request {
  return [request.URL.scheme caseInsensitiveCompare:@"ardia-favicon"] == NSOrderedSame;
}

- (id)sendRequest:(NSURLRequest *)request withDelegate:(id<RCTURLRequestDelegate>)delegate {
  NSObject *token = [NSObject new];
  NSURL *url = request.URL;
  ardia_favicons::Load(url.absoluteString, ^(ArdiaFaviconDelivery *delivery) {
    NSURLResponse *response = [[NSURLResponse alloc] initWithURL:url MIMEType:@"image/png" expectedContentLength:-1 textEncodingName:nil];
    const BOOL delivered = [delivery deliver:^(NSData *png) {
      [delegate URLRequest:token didReceiveResponse:response];
      [delegate URLRequest:token didReceiveData:png];
    }];
    if (delivered) return [delegate URLRequest:token didCompleteWithError:nil];
    [delegate URLRequest:token didCompleteWithError:[NSError errorWithDomain:NSURLErrorDomain code:NSURLErrorResourceUnavailable userInfo:@{NSLocalizedDescriptionKey : @"No icon at that address"}]];
  });
  return token;
}

@end
