#pragma once

#import <AppKit/AppKit.h>

@class ArdiaWebView;
@class ArdiaConsentStamp;

namespace ardia_pip {

void WatchZoom();

NSWindow *GrabbedWindow();

void VideoEntered(ArdiaWebView *view, NSString *host, ArdiaConsentStamp *stamp);

void DocumentEntered(ArdiaWebView *view, ArdiaConsentStamp *stamp);

void TabRequestedActivation(ArdiaWebView *view);

}
