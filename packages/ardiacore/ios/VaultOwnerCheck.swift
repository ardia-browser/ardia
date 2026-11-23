import Foundation
import LocalAuthentication

enum VaultOwnerCheck {
  private static let grantLock = NSLock()
  nonisolated(unsafe) private static var grants = VaultTouchGrants()
  nonisolated(unsafe) private static var presence = VaultPresence<LAContext>()
  nonisolated(unsafe) private static var grantContext: LAContext?
  nonisolated(unsafe) private static var lastPrompt: Task<Void, Never>?
  @TaskLocal static var fillTab: String?

  static func grant(scope: String, context: LAContext? = nil) {
    guard !scope.isEmpty else {
      context?.invalidate()
      return
    }
    grantLock.lock()
    grants.grant(scope, at: Date())
    let previous = grantContext
    grantContext = context
    grantLock.unlock()
    if previous !== context { previous?.invalidate() }
  }

  static func passOn(_ handOn: VaultHandOn?, provider: String) {
    guard let handOn, let scope = VaultTouchGrants.handOn(provider: provider, origin: handOn.origin, tab: handOn.tab) else { return }
    grant(scope: scope)
  }

  static func dropGrant() {
    grantLock.lock()
    grants.drop()
    let held = grantContext
    grantContext = nil
    grantLock.unlock()
    held?.invalidate()
  }

  static func reset() {
    grantLock.lock()
    grants.drop()
    let context = presence.clear()
    let held = grantContext
    grantContext = nil
    grantLock.unlock()
    context?.invalidate()
    held?.invalidate()
  }

  static var presenceContext: LAContext? { grantLock.withLock { presence.context(at: .now) } }

  static var lastConfirmed: ContinuousClock.Instant? { grantLock.withLock { presence.confirmedAt } }

  static var recentlyConfirmed: Bool { grantLock.withLock { presence.isRecent(at: .now) } }

  static func noteConfirmed() { openPresence(with: nil) }

  private static func openPresence(with context: LAContext?) {
    let replaced = grantLock.withLock { presence.confirm(at: .now, context: context) }
    replaced?.invalidate()
  }

  static func confirmedRecently(_ reason: String, touchScope: String? = nil) async -> Bool {
    if recentlyConfirmed { return true }
    if let touchScope, take(touchScope) { return true }
    guard let asked = await ask(reason, unlessRecentlyConfirmed: true) else { return false }
    openPresence(with: asked.context)
    return true
  }

  private static func take(_ scope: String) -> Bool {
    grantLock.lock()
    let taken = grants.take(scope, at: Date())
    let context = taken || !grants.isHeld ? grantContext : nil
    if context != nil { grantContext = nil }
    grantLock.unlock()
    guard taken else {
      context?.invalidate()
      return false
    }
    if VaultTouchGrants.isUnlock(scope) {
      openPresence(with: context)
    } else {
      context?.invalidate()
    }
    return true
  }

  static func takeFillGrant(provider: String, item: String, origin: String) -> Bool {
    guard let tab = fillTab, !tab.isEmpty else { return false }
    return take(VaultTouchGrants.fill(provider: provider, item: item, origin: origin, tab: tab))
  }

  static var biometricsAvailable: Bool {
    var problem: NSError?
    let context = LAContext()
    defer { context.invalidate() }
    return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem)
  }

  static func confirm(_ reason: String, touchScope: String? = nil) async -> Bool {
    if let touchScope, take(touchScope) { return true }
    guard let asked = await ask(reason) else { return false }
    openPresence(with: asked.context)
    return true
  }

  static func confirmEach(_ reason: String, touchScope: String? = nil) async -> Bool {
    if let touchScope, take(touchScope) { return true }
    guard let asked = await ask(reason) else { return false }
    asked.context?.invalidate()
    return true
  }

  private struct Asked: @unchecked Sendable {
    let context: LAContext?
  }

  private static func ask(_ reason: String, unlessRecentlyConfirmed: Bool = false) async -> Asked? {
    let mine = grantLock.withLock {
      let previous = lastPrompt
      let mine = Task<Asked?, Never> {
        await previous?.value
        if unlessRecentlyConfirmed, recentlyConfirmed { return Asked(context: nil) }
        return await prompt(reason)
      }
      lastPrompt = Task { _ = await mine.value }
      return mine
    }
    return await mine.value
  }

  private static func prompt(_ reason: String) async -> Asked? {
    let config = LaunchConfig.shared
    if config.background {
      let granted = config.testValue("reauth") == "granted"
      NSLog("[vaults] owner check (%@) in a hidden test instance, no prompt: %@", reason, granted ? "granted" : "denied")
      return granted ? Asked(context: nil) : nil
    }
    let biometric = LAContext()
    var problem: NSError?
    if biometric.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &problem) {
      var code: LAError.Code?
      let granted: Bool
      do {
        granted = try await biometric.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
      } catch {
        granted = false
        code = (error as? LAError)?.code
      }
      switch VaultOwnerPrompt.afterBiometrics(granted: granted, code: code) {
      case .granted: return Asked(context: biometric)
      case .denied:
        biometric.invalidate()
        return nil
      case .askWithPassword:
        biometric.invalidate()
      }
    } else {
      biometric.invalidate()
    }
    let owner = LAContext()
    guard owner.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem),
      (try? await owner.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) == true
    else {
      owner.invalidate()
      return nil
    }
    return Asked(context: owner)
  }
}
