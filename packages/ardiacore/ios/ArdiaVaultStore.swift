import Foundation
import os

enum ArdiaVaultStore {
  private static let readTimeout: TimeInterval = 15
  private static let ardiaProfiles = OSAllocatedUnfairLock(initialState: ArdiaVaultProfiles())

  static func setArdiaProfiles(_ profiles: [String]) {
    guard ardiaProfiles.withLock({ $0.replace(with: profiles) }) else { return }
    Task { _ = await ArdiaVaultIndex.shared.refreshState(explicit: true) }
  }

  static var onArdia: ArdiaVaultProfiles { ardiaProfiles.withLock { $0 } }

  @MainActor
  static func isOnArdia(_ profile: String) -> Bool {
    onArdia.serves(profile, base: ArdiaHost.baseProfile(of: profile))
  }

  static func offers(_ profile: String) async -> Bool {
    await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.main.async {
        guard MainActor.assumeIsolated({ isOnArdia(profile) }) else { return done.resume(returning: false) }
        ArdiaServices.profileToggles(profile: profile, set: nil) { value, error in
          if let error { NSLog("[vaults] couldn't read whether a profile offers passwords: %@", error) }
          done.resume(returning: error == nil && (value as? [String: Any])?["passwords"] as? Bool == true)
        }
      }
    }
  }

  static func offeredProfiles() async -> [String] {
    var offered: [String] = []
    for profile in await loadedProfiles() where await offers(profile) { offered.append(profile) }
    return offered
  }

  static func isOn() async -> Bool {
    let loaded = await loadedProfiles()
    guard !loaded.isEmpty else { return true }
    for profile in loaded where await offers(profile) { return true }
    return false
  }

  private static func loadedProfiles() async -> [String] {
    await MainActor.run { ArdiaHost.loadedProfiles }
  }

  static func baseProfile(_ profile: String) async -> String {
    await MainActor.run { ArdiaHost.baseProfile(of: profile) }
  }

  private struct Unsendable<Value>: @unchecked Sendable {
    let value: Value
  }

  static func logins(_ profile: String) async -> [ArdiaVaultLogin] { await listedLogins(profile) ?? [] }

  static func listedLogins(_ profile: String) async -> [ArdiaVaultLogin]? {
    let listed = await withCheckedContinuation { (done: CheckedContinuation<Unsendable<Any?>, Never>) in
      DispatchQueue.main.async {
        ArdiaServices.listPasswords(profile: profile) { value, error in
          done.resume(returning: Unsendable(value: error == nil ? value : nil))
        }
      }
    }
    guard let value = listed.value else { return nil }
    return logins(in: value, profile: profile)
  }

  private static func logins(in value: Any?, profile: String) -> [ArdiaVaultLogin] {
    let entries = (value as? [String: Any])?["passwords"] as? [[String: Any]] ?? []
    var logins: [ArdiaVaultLogin] = []
    logins.reserveCapacity(entries.count)
    var seen = Set<String>()
    for entry in entries {
      guard let origin = entry["origin"] as? String, let username = entry["username"] as? String, VaultOriginMatch.isWebOrigin(origin) else {
        continue
      }
      guard seen.insert(origin + "\n" + username).inserted else { continue }
      logins.append(ArdiaVaultLogin(profile: profile, origin: origin, username: username))
    }
    return logins
  }

  static func secretEntries(_ profile: String) async -> [[String: Any]]? {
    let reply = await withCheckedContinuation { (done: CheckedContinuation<Unsendable<[[String: Any]]?>, Never>) in
      DispatchQueue.main.async {
        ArdiaEngineBridge.callForSecretReply("ac_passwords_logins", profile: profile, timeout: readTimeout) { reply in
          done.resume(returning: Unsendable(value: reply?["logins"] as? [[String: Any]]))
        }
      }
    }
    return reply.value
  }

  static func password(_ login: ArdiaVaultLogin) async -> String? {
    guard let entries = await secretEntries(login.profile) else { return await revealed(login) }
    let match = entries.first { entry in
      guard (entry["username"] as? String) == login.username, let realm = entry["realm"] as? String else { return false }
      return ArdiaVault.originOfRealm(realm) == login.origin
    }
    return match?["password"] as? String
  }

  private static func revealed(_ login: ArdiaVaultLogin) async -> String? {
    await withCheckedContinuation { (done: CheckedContinuation<String?, Never>) in
      DispatchQueue.main.async {
        ArdiaServices.password(profile: login.profile, origin: login.origin, username: login.username) { value, _ in
          done.resume(returning: (value as? [String: Any])?["password"] as? String)
        }
      }
    }
  }

  static func save(_ login: ArdiaVaultLogin, password: String) async -> Bool {
    await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.main.async {
        ArdiaServices.savePassword(profile: login.profile, origin: login.origin, username: login.username, password: password) { _, error in
          if let error { NSLog("[vaults] ardia couldn't save a login: %@", error) }
          done.resume(returning: error == nil)
        }
      }
    }
  }

  static func update(_ login: ArdiaVaultLogin, password: String) async -> Bool {
    await update(login, newUsername: nil, password: password)
  }

  static func update(_ login: ArdiaVaultLogin, newUsername: String?, password: String?) async -> Bool {
    await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.main.async {
        ArdiaServices.updatePassword(profile: login.profile, origin: login.origin, username: login.username, newUsername: newUsername,
                                     newPassword: password) { _, error in
          if let error { NSLog("[vaults] ardia couldn't update a login: %@", error) }
          done.resume(returning: error == nil)
        }
      }
    }
  }

  static func remove(_ login: ArdiaVaultLogin) async -> Bool {
    await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
      DispatchQueue.main.async {
        ArdiaServices.deletePassword(profile: login.profile, origin: login.origin, username: login.username) { _, error in
          if let error { NSLog("[vaults] ardia couldn't remove a login: %@", error) }
          done.resume(returning: error == nil)
        }
      }
    }
  }
}
