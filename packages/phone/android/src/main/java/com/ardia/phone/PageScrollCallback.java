package com.ardia.phone;

import android.graphics.Rect;
import android.os.CancellationSignal;
import android.view.ScrollCaptureCallback;
import android.view.ScrollCaptureSession;
import androidx.annotation.RequiresApi;
import java.util.function.Consumer;

@RequiresApi(31)
final class PageScrollCallback implements ScrollCaptureCallback {
    private final PageScrollCapture capture;

    PageScrollCallback(PageScrollCapture capture) {
        this.capture = capture;
    }

    @Override
    public void onScrollCaptureSearch(CancellationSignal signal, Consumer<Rect> onReady) {
        capture.search(signal, onReady);
    }

    @Override
    public void onScrollCaptureStart(ScrollCaptureSession session, CancellationSignal signal, Runnable onReady) {
        capture.start(signal, onReady);
    }

    @Override
    public void onScrollCaptureImageRequest(ScrollCaptureSession session, CancellationSignal signal, Rect captureArea, Consumer<Rect> onComplete) {
        capture.request(session, signal, captureArea, onComplete);
    }

    @Override
    public void onScrollCaptureEnd(Runnable onReady) {
        capture.end(onReady);
    }
}
