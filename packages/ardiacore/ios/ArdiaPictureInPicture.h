#pragma once

#import <AppKit/AppKit.h>

@class ArdiaWebView;
@class ArdiaConsentStamp;

namespace ardia_pip {

void WatchZoom();
void RefreshPinchesFromOtherApps();
void ForgetSavedSize();

NSWindow *GrabbedWindow();

void VideoEntered(ArdiaWebView *view, NSString *host, ArdiaConsentStamp *stamp);

void DocumentEntered(ArdiaWebView *view, ArdiaConsentStamp *stamp);

BOOL TabRequestedActivation(ArdiaWebView *view, BOOL *fromOtherApp);

}
