import AppKit
import ArdiaCore

final class QuitFlow {
  static let shared = QuitFlow()

  private enum Phase {
    case idle
    case saving(wait: Timer?, lateAlert: NSAlert?)
    case waitingForUpdater
  }

  private var phase = Phase.idle
  private var attempt = 0
  private static let saveWait: TimeInterval = 5
  static let heldHoverLoss = "hover-lost-at-quit.json"
  static let committedHoverLossPrefix = "hover-lost-at-quit-committed-"
  private static let commitsHoverLossOnTerminate = NotificationCenter.default.addObserver(
    forName: NSApplication.willTerminateNotification, object: nil, queue: nil
  ) { _ in commitHeldHoverLoss() }
  private static let cancelsHoverLossOnQuitCancelled = NotificationCenter.default.addObserver(
    forName: PluginProgramLinks.quitCancelledNotification, object: nil, queue: nil
  ) { _ in cancelHeldHoverLoss() }

  static func commitHeldHoverLoss() {
    guard ArdiaHost.hoverLossReportedAtQuitIsOpen(), let held = DocumentStore.read(heldHoverLoss) else { return }
    let seconds = ArdiaHost.hoverLossReportedAtQuitSeconds()
    HoverLossQuitCommit.commit(
      held: held,
      seconds: seconds,
      prefix: committedHoverLossPrefix,
      write: { DocumentStore.writeDurablySync($0, $1, allowWhenClosed: true) },
      list: { DocumentStore.list($0) },
      remove: { DocumentStore.removeSync($0, allowWhenClosed: true) },
      markCommitted: { ArdiaHost.markHoverLossCommittedAtQuit() },
      removeHeld: { DocumentStore.removeSync(heldHoverLoss, allowWhenClosed: true) }
    )
  }

  static func cancelHeldHoverLoss() {
    ArdiaHost.cancelHoverLossAtQuit()
    DocumentStore.removeSync(heldHoverLoss, allowWhenClosed: true)
  }

  private var isSaving: Bool {
    if case .saving = phase { return true }
    return false
  }

  func confirm() {
    if MenuState.current.warnBeforeQuitting {
      let alert = NSAlert()
      alert.messageText = "Are you sure you want to quit \(ProcessInfo.processInfo.processName)?"
      alert.informativeText = "Your windows and tabs will be restored the next time you open it."
      alert.addButton(withTitle: "Quit")
      alert.addButton(withTitle: "Cancel")
      alert.showsSuppressionButton = true
      alert.suppressionButton?.title = "Don't ask again"
      let response = alert.runModal()
      if alert.suppressionButton?.state == .on { ShellEvents.send(.app, ["type": "quitWarningSuppressed"]) }
      guard response == .alertFirstButtonReturn else { return }
    }
    NSApp.terminate(nil)
  }

  func shouldTerminate() -> NSApplication.TerminateReply {
    PluginProgramLinks.holdAfterUpdates()
    guard ShellEvents.isAttached(.app), ShellEvents.isAttached(.window) else {
      guard AppUpdater.shared.holdsQuitForStagedUpdate || PluginProgramLinks.afterUpdatesRunning else { return .terminateNow }
      quitAfterUpdaterSettles()
      return .terminateLater
    }
    guard confirmActiveDownloads() else {
      PluginProgramLinks.resumeAfterUpdates()
      return .terminateCancel
    }
    attempt += 1
    phase = .saving(wait: nil, lateAlert: nil)
    WindowManager.shared.flushFrameReports()
    _ = Self.commitsHoverLossOnTerminate
    _ = Self.cancelsHoverLossOnQuitCancelled
    ArdiaHost.reportHoverLossAtQuit()
    ShellEvents.send(.app, ["type": "willQuit"])
    waitForSave()
    return .terminateLater
  }

  private func waitForSave() {
    let timer = Timer(timeInterval: Self.saveWait, repeats: false) { [weak self] _ in self?.saveIsLate() }
    RunLoop.main.add(timer, forMode: .common)
    if isSaving { phase = .saving(wait: timer, lateAlert: nil) }
  }

  private func saveIsLate() {
    if isSaving { phase = .saving(wait: nil, lateAlert: nil) }
    let message = "\(ProcessInfo.processInfo.processName) can't save your session right now."
    if LaunchConfig.shared.background {
      NSLog("[shell] quit alert: \(message) (Wait / Quit Without Saving): Wait")
      return waitForSave()
    }
    let alert = NSAlert()
    alert.messageText = message
    alert.informativeText = "If you quit now, your windows and tabs open as they were when it last saved."
    alert.addButton(withTitle: "Wait")
    alert.addButton(withTitle: "Quit Without Saving")
    if isSaving { phase = .saving(wait: nil, lateAlert: alert) }
    let response = alert.runModal()
    if case .saving(let wait, let shown) = phase, shown === alert { phase = .saving(wait: wait, lateAlert: nil) }
    switch response {
    case .alertFirstButtonReturn: waitForSave()
    case .alertSecondButtonReturn:
      guard isSaving else { return }
      DocumentStore.close()
      quitAfterUpdaterSettles()
    default: break
    }
  }

  private func confirmActiveDownloads() -> Bool {
    let count = MenuState.current.downloadsInProgress
    guard count > 0 else { return true }
    let alert = NSAlert()
    alert.messageText = "Are you sure you want to quit \(ProcessInfo.processInfo.processName)?"
    alert.informativeText = count == 1
      ? "You have 1 download in progress. If you quit now, this download will be cancelled."
      : "You have \(count) downloads in progress. If you quit now, these downloads will be cancelled."
    alert.addButton(withTitle: "Quit")
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }

  func replyToTerminate(_ ok: Bool) {
    if case .idle = phase { return }
    if case .waitingForUpdater = phase, ok { return }
    if case .saving(let wait, let lateAlert) = phase {
      wait?.invalidate()
      phase = .saving(wait: nil, lateAlert: nil)
      if lateAlert != nil { NSApp.stopModal(withCode: .abort) }
    }
    guard ok else {
      phase = .idle
      attempt += 1
      PluginProgramLinks.resumeAfterUpdates()
      Self.cancelHeldHoverLoss()
      return NSApp.reply(toApplicationShouldTerminate: false)
    }
    guard isSaving else { return }
    if DocumentStore.flush() { ArdiaChromeWindowHost.recordLaunchLayout() } else { ArdiaChromeWindowHost.forgetLaunchPictures() }
    quitAfterUpdaterSettles()
  }

  private func quitAfterUpdaterSettles() {
    if case .idle = phase { attempt += 1 }
    phase = .waitingForUpdater
    let attempt = self.attempt
    var holds = 2
    let settled = { [weak self] in
      holds -= 1
      guard holds == 0, let self, self.attempt == attempt, case .waitingForUpdater = self.phase else { return }
      self.phase = .idle
      NSApp.reply(toApplicationShouldTerminate: true)
    }
    PluginProgramLinks.stopAfterUpdates(done: settled)
    AppUpdater.shared.dropOffChannelStagedUpdateBeforeQuit(then: settled)
  }
}
