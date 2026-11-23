import CryptoKit
import Foundation
import os

enum VaultLockPolicy {
  static let unlockedAtQuitAccount = "unlocked-at-quit"
  static let markerKeyAccount = "unlocked-at-quit-key"
  static let staysOpenAccount = "stays-open-at-quit"
  private static let markerKeySize = SymmetricKeySize.bits256

  private struct Options {
    var locksOnQuit = true
    var locksOnScreenLock = true
    var openProviders: [String] = []
  }

  private static let options = OSAllocatedUnfairLock(initialState: Options())

  static var locksOnScreenLock: Bool { options.withLock { $0.locksOnScreenLock } }

  static func set(lockOnQuit: Bool, lockOnScreenLock: Bool) {
    options.withLock {
      $0.locksOnQuit = lockOnQuit
      $0.locksOnScreenLock = lockOnScreenLock
    }
    if lockOnQuit {
      forgetUnlockedAtQuit()
      VaultKeychain.delete(staysOpenAccount)
    } else if VaultKeychain.protectsItems, VaultKeychain.readProtected(staysOpenAccount) == nil {
      VaultKeychain.write(staysOpenAccount, "1")
    }
  }

  private static var storedStaysOpen: Bool {
    VaultKeychain.protectsItems && VaultKeychain.readProtected(staysOpenAccount) == "1"
  }

  private static func markerKey(creating: Bool) -> SymmetricKey? {
    guard VaultKeychain.protectsItems else { return nil }
    if let text = VaultKeychain.readProtected(markerKeyAccount), let data = Data(base64Encoded: text), data.count == markerKeySize.bitCount / 8 {
      return SymmetricKey(data: data)
    }
    guard creating else { return nil }
    let fresh = SymmetricKey(size: markerKeySize)
    guard VaultKeychain.write(markerKeyAccount, fresh.withUnsafeBytes { Data($0).base64EncodedString() }) else { return nil }
    return fresh
  }

  static func noteOpen(_ providers: [String]) { options.withLock { $0.openProviders = providers } }

  static func recordQuit() {
    let (staysOpen, open) = options.withLock { (!$0.locksOnQuit, $0.openProviders) }
    guard staysOpen, !open.isEmpty, let boot = bootSession, VaultSessionStore.shared.touchID, let key = markerKey(creating: true),
      let text = VaultQuitMarker.signed(["boot": boot, "providers": open], key: key)
    else { return forgetUnlockedAtQuit() }
    VaultKeychain.write(unlockedAtQuitAccount, text)
  }

  static func takeUnlockedAtQuit() -> [String] {
    guard VaultKeychain.protectsItems, let text = VaultKeychain.readProtected(unlockedAtQuitAccount) else { return [] }
    forgetUnlockedAtQuit()
    guard storedStaysOpen, let key = markerKey(creating: false), let marker = VaultQuitMarker.verified(text, key: key),
      let boot = marker["boot"] as? String, boot == bootSession, let providers = marker["providers"] as? [String]
    else { return [] }
    return providers.filter { VaultRegistry.provider($0) != nil }
  }

  static func forgetUnlockedAtQuit() {
    VaultKeychain.delete(unlockedAtQuitAccount)
  }

  static var bootSession: String? {
    var size = 0
    guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1 else { return nil }
    var bytes = [CChar](repeating: 0, count: size)
    guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else { return nil }
    let text = String(cString: bytes)
    return text.isEmpty ? nil : text
  }
}
