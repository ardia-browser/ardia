import AppKit

final class VaultAutoLock: @unchecked Sendable {
  static let shared = VaultAutoLock()
  static let screenLocked = Notification.Name("com.apple.screenIsLocked")
  static let screenUnlocked = Notification.Name("com.apple.screenIsUnlocked")
  static let idleCheckInterval: TimeInterval = 60
  static let idleCheckTolerance: TimeInterval = 15

  private let lock = NSLock()
  private var observers: [(NotificationCenter, NSObjectProtocol)] = []
  private var timer: Timer?
  private var started = false
  private var screenIsLocked = false

  var isScreenLocked: Bool {
    lock.lock()
    defer { lock.unlock() }
    return screenIsLocked
  }

  func start() {
    DispatchQueue.main.async { self.begin() }
    Task {
      await ArdiaVaultBackup.shared.prewarm()
      await ArdiaVaultIndex.shared.prewarm()
    }
  }

  func watchIdle(_ on: Bool) {
    DispatchQueue.main.async { self.setTimer(on) }
  }

  private func setTimer(_ on: Bool) {
    lock.lock()
    let running = timer
    lock.unlock()
    guard on != (running != nil) else { return }
    running?.invalidate()
    var fresh: Timer?
    if on {
      let made = Timer(timeInterval: Self.idleCheckInterval, repeats: true) { _ in
        Task { await VaultBroker.shared.lockIdle() }
      }
      made.tolerance = Self.idleCheckTolerance
      RunLoop.main.add(made, forMode: .common)
      fresh = made
    }
    lock.lock()
    timer = fresh
    lock.unlock()
  }

  private func begin() {
    guard !started else { return }
    started = true
    let app = NotificationCenter.default
    observe(app, NSApplication.willTerminateNotification, on: nil) { _ in VaultLockPolicy.recordQuit() }
    guard !LaunchConfig.shared.background else { return }
    observe(app, NSApplication.didBecomeActiveNotification) { _ in
      Task { await ArdiaVaultBackup.shared.backUpIfDue() }
    }
    let workspace = NSWorkspace.shared.notificationCenter
    observe(workspace, NSWorkspace.willSleepNotification) { _ in VaultAutoLock.shared.lockForAway() }
    observe(workspace, NSWorkspace.sessionDidResignActiveNotification) { _ in VaultAutoLock.shared.screenWentAway() }
    observe(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { _ in VaultAutoLock.shared.screenCameBack() }
    let distributed = DistributedNotificationCenter.default()
    observe(distributed, Self.screenLocked) { _ in VaultAutoLock.shared.screenWentAway() }
    observe(distributed, Self.screenUnlocked) { _ in VaultAutoLock.shared.screenCameBack() }
  }

  private func observe(_ center: NotificationCenter, _ name: Notification.Name, on queue: OperationQueue? = .main,
                       _ handle: @escaping @Sendable (Notification) -> Void) {
    observers.append((center, center.addObserver(forName: name, object: nil, queue: queue, using: handle)))
  }

  private func screenWentAway() {
    lock.lock()
    screenIsLocked = true
    lock.unlock()
    lockForAway()
  }

  private func lockForAway() {
    guard VaultLockPolicy.locksOnScreenLock else { return }
    ArdiaWebView.wipeVaultCaptures()
    Task {
      await VaultBroker.shared.lockAll()
      await ArdiaVaultBackup.shared.dropSecrets()
    }
  }

  private func screenCameBack() {
    lock.lock()
    let was = screenIsLocked
    screenIsLocked = false
    lock.unlock()
    guard was else { return }
    Task { await ArdiaVaultBackup.shared.backUpIfDue() }
  }
}
