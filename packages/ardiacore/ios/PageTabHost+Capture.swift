import AppKit
import ImageIO
import QuartzCore

extension PageTabHost {
  func toggleCapture() -> Bool {
    if captureOverlay != nil || captureStarting {
      endCapture()
      return false
    }
    guard window != nil, !isHiddenOrHasHiddenAncestor, page.superview === self, !fullPageRunning else { return false }
    captureStarting = true
    captureAttempt += 1
    captureStartedAt = CACurrentMediaTime()
    let attempt = captureAttempt
    let size = bounds.size
    page.copyCapturePicture { [weak self] picture, frame in
      CaptureOverlay.withGray(picture) { picture, gray in
        guard let self, self.captureStarting, attempt == self.captureAttempt else { return }
        self.captureStarting = false
        guard let picture, self.window != nil, !self.isHiddenOrHasHiddenAncestor, !frame.isEmpty else {
          return self.sendCaptureEnding("failed")
        }
        let place = self.bounds.size == size ? self.convert(frame, from: self.page) : self.bounds
        let overlay = CaptureOverlay(frame: place, picture: picture, gray: gray, pictureSize: frame.size, page: self.page) { [weak self] ending in
          self?.captureEnded(ending)
        }
        self.captureOverlay = overlay
        self.addSubview(overlay, positioned: .above, relativeTo: self.page)
        self.watchCaptureArea()
      }
    }
    return true
  }

  func captureFullPage() -> Bool {
    guard window != nil, !isHiddenOrHasHiddenAncestor, !fullPageRunning else { return false }
    endCapture()
    captureAttempt += 1
    let attempt = captureAttempt
    fullPageAttempt = attempt
    fullPageRunning = true
    captureStartedAt = CACurrentMediaTime()
    let backing = window?.backingScaleFactor ?? 2
    page.copyFullPage { [weak self] png in
      CaptureClipboard.imageWork.async {
        let image = png.flatMap { CGImageSourceCreateWithData($0 as CFData, nil) }.flatMap { CGImageSourceCreateImageAtIndex($0, 0, nil) }
        DispatchQueue.main.async { self?.deliverFullPage(image, attempt: attempt, backing: backing) }
      }
    }
    return true
  }

  private func deliverFullPage(_ image: CGImage?, attempt: Int, backing: CGFloat) {
    guard fullPageAttempt == attempt, let image else {
      fullPageRunning = false
      if fullPageAttempt == attempt { endFullPage("failed") }
      return
    }
    let points = NSSize(width: CGFloat(image.width) / backing, height: CGFloat(image.height) / backing)
    CaptureClipboard.copy(image, points: points, if: { [weak self] in self?.fullPageAttempt == attempt }) { [weak self] capture in
      guard let self else { return }
      self.fullPageRunning = false
      guard self.fullPageAttempt == attempt else { return }
      if let capture {
        self.endFullPage("copied", width: image.width, height: image.height, capture: capture)
      } else {
        self.endFullPage("failed")
      }
    }
  }

  private func endFullPage(_ outcome: String, width: Int = 0, height: Int = 0, capture: Int? = nil) {
    fullPageAttempt = nil
    sendCaptureEnding(outcome, kind: "page", width: width, height: height, capture: capture)
  }

  private func dropFullPage() {
    guard fullPageAttempt != nil else { return }
    endFullPage("cancelled")
  }

  func notePageNavigation(_ payload: [String: Any]) {
    guard let committedAt = payload["committedAt"] as? Double else { return }
    let committedNewDocument = pageCommittedAt.map { $0 != committedAt } ?? false
    pageCommittedAt = committedAt
    guard committedNewDocument else { return }
    if captureOverlay != nil || captureStarting { endCapture() }
    dropFullPage()
  }

  func endCapture() {
    if captureStarting {
      captureStarting = false
      captureAttempt += 1
      sendCaptureEnding("cancelled")
    }
    captureOverlay?.cancel()
  }

  private func watchCaptureArea() {
    stopWatchingCaptureArea()
    guard let area = page.captureArea else { return }
    captureAreaObserver = NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: area, queue: .main) { [weak self] _ in
      self?.alignCapture()
    }
  }

  private func stopWatchingCaptureArea() {
    if let captureAreaObserver { NotificationCenter.default.removeObserver(captureAreaObserver) }
    captureAreaObserver = nil
  }

  private func alignCapture() {
    guard let overlay = captureOverlay, let area = page.captureArea, let holder = area.superview else { return }
    let place = convert(area.frame, from: holder)
    guard place != overlay.frame else { return }
    overlay.frame = place
    overlay.needsLayout = true
  }

  private func captureEnded(_ ending: CaptureOverlay.Ending) {
    stopWatchingCaptureArea()
    captureOverlay = nil
    switch ending {
    case .copied(let shot):
      CaptureClipboard.copy(shot.image, points: shot.points) { [weak self] capture in
        if let capture {
          self?.sendCaptureEnding("copied", kind: shot.kind, width: shot.image.width, height: shot.image.height, capture: capture)
        } else {
          self?.sendCaptureEnding("failed")
        }
      }
    case .cancelled:
      sendCaptureEnding("cancelled")
    case .failed:
      sendCaptureEnding("failed")
    }
  }

  private func sendCaptureEnding(_ outcome: String, kind: String? = nil, width: Int = 0, height: Int = 0, capture: Int? = nil) {
    let ms = Int(((CACurrentMediaTime() - captureStartedAt) * 1000).rounded())
    var payload: [String: Any] = ["outcome": outcome, "width": width, "height": height, "ms": ms]
    if let kind { payload["kind"] = kind }
    if let capture { payload["capture"] = capture }
    send("capture", payload: payload)
  }
}
