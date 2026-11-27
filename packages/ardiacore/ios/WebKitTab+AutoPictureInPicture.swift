import AppKit

enum PictureInPictureAnswer {
  case opened
  case nothingPlaying
  case failed
}

extension WebKitTab {
  private static let leftAppKey = "leftApp"
  private static let playsHandlerInstalled: Void = {
    ArdiaChromeWindowHost.playsForAutoPictureInPictureHandler = { window in
      WebKitHub.shared.transfers.liveTabs.contains { $0.window === window && $0.visible && $0.playsForAutoPictureInPicture }
    }
  }()

  var autoPictureInPictureRule: WebKitAutoPictureInPicture {
    get { webView?.autoPictureInPictureRule ?? WebKitAutoPictureInPicture() }
    set { webView?.autoPictureInPictureRule = newValue }
  }

  private var playsMedia: Bool {
    guard let view = webView else { return false }
    return !playingFrames.isEmpty || view.cameraCaptureState == .active || view.microphoneCaptureState == .active
  }

  var playsForAutoPictureInPicture: Bool { autoPictureInPicture && playsMedia && !autoPictureInPictureRule.heldUntilBack }

  func watchSight() {
    stopWatchingSight()
    guard !closed, let window else { return }
    _ = Self.playsHandlerInstalled
    sightObserver = NotificationCenter.default.addObserver(forName: NSNotification.Name.ArdiaWindowSeenDidChange, object: window, queue: .main) { [weak self] note in
      self?.updateSight()
      if (note.userInfo?[Self.leftAppKey] as? Bool) == true { self?.noteStayedOnAppSwitch() }
    }
    updateSight()
  }

  func stopWatchingSight() {
    if let sightObserver { NotificationCenter.default.removeObserver(sightObserver) }
    sightObserver = nil
  }

  private var seenByUser: Bool {
    guard let window else { return false }
    return WebKitFullscreenPage.seen(visible: visible, heldInFullscreen: pageHeldInFullscreen, windowSeen: ArdiaChromeWindowHost.userSees(window), fullscreenWindowSeen: fullscreenWindowSeen)
  }

  func updateSight() {
    guard !closed, let window else { return }
    followPageFullScreen()
    let seen = seenByUser
    let kept = seen && ArdiaChromeWindowHost.userSeesOnlyThroughWindowServer(window)
    if !kept {
      pageMedia.keptByWindowServer = false
    } else if !pageMedia.keptByWindowServer && playsForAutoPictureInPicture {
      pageMedia.keptByWindowServer = true
      emit("autoPictureInPictureKept", ArdiaConsentStamp.begin().onto(["appSwitch": false]))
    }
    let wasHeld = autoPictureInPictureRule.heldUntilBack
    switch autoPictureInPictureRule.sight(seen, userIn: !ArdiaChromeWindowHost.userInAnotherApp(), inline: !pageHeldInFullscreen, enabled: autoPictureInPicture, playing: playsMedia) {
    case .open:
      let stamp = ArdiaConsentStamp.begin()
      let request = autoPictureInPictureRule.openRequests
      let view = webView
      setPictureInPicture(true, automatic: true, overFullScreen: autoPictureInPictureRule.opensOverFullScreen) { [weak self, weak view] answer in
        guard let self, let view, !self.closed, self.webView === view else { return }
        view.autoPictureInPictureRule.answered(request, opened: answer == .opened)
        if answer == .nothingPlaying { self.emit("autoPictureInPictureKept", stamp.onto(["reason": "nothingPlaying"])) }
      }
    case .close: setPictureInPicture(false) { _ in }
    case .heldForFullScreen: ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "autoPictureInPictureFullscreenHold"]))
    case .closeHeldForFullScreen:
      setPictureInPicture(false) { _ in }
      ArdiaEvents.emit("webKit.counted", data: ArdiaConsentStamp.begin().onto(["name": "autoPictureInPictureFullscreenHold"]))
    case .none: break
    }
    if wasHeld && !autoPictureInPictureRule.heldUntilBack { autoPictureInPictureInputsChanged() }
  }

  private func followPageFullScreen() {
    autoPictureInPictureRule.pageFullScreen(WebKitFullscreenPage.isOn(webView?.fullscreenState ?? .notInFullscreen), tab: browserId)
  }

  private func noteStayedOnAppSwitch() {
    guard !closed, visible, !autoPictureInPictureRule.reportedActive, seenByUser, playsForAutoPictureInPicture else { return }
    emit("autoPictureInPictureKept", ArdiaConsentStamp.begin().onto(["appSwitch": true]))
  }

  func notePictureInPicture(_ data: [String: Any]?, frame: String) {
    let wasHeld = autoPictureInPictureRule.heldUntilBack
    guard let (active, reported) = autoPictureInPictureRule.report(data, from: frame) else { return }
    if reported.closeAgain { setPictureInPicture(false) { _ in } }
    if reported.heldNow {
      emit("autoPictureInPictureKept", ArdiaConsentStamp.begin().onto(["reason": "closedWhileAway"]))
      autoPictureInPictureInputsChanged()
    } else if wasHeld && !autoPictureInPictureRule.heldUntilBack {
      autoPictureInPictureInputsChanged()
    }
    emit("pictureInPicture", ["kind": "video", "active": active])
  }

  func pictureInPicturePageGone() {
    if autoPictureInPictureRule.pageGone() { emit("pictureInPicture", ["kind": "video", "active": false]) }
  }

  func autoPictureInPictureInputsChanged() {
    let plays = playsForAutoPictureInPicture
    guard plays != pageMedia.playedForAutoPictureInPicture else { return }
    pageMedia.playedForAutoPictureInPicture = plays
    guard let window else { return }
    ArdiaChromeWindowHost.reconsiderSight(of: window)
    updateSight()
  }
}
