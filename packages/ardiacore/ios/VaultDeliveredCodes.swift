import Foundation

enum VaultDeliveredAccess: String, Sendable {
  case off
  case needsAccess
  case on
}

struct VaultDeliveredCode: Sendable, Equatable {
  var id: String
  var source: VaultDeliveredSource
  var sender: String
  var site: String?
  var boundDomain: String?
  var iframeDomain: String?
  var code: String
  var receivedAt: Date
  var expiresAt: Date
  var messageKey: String

  var bound: Bool { boundDomain != nil }

  func fills(frame: String, top: String?, userChose: Bool) -> Bool {
    guard let boundDomain else { return userChose }
    guard let top, let topSite = Self.site(top), let frameSite = Self.site(frame) else { return false }
    let boundSite = VaultOriginMatch.registrableDomain(boundDomain)
    guard topSite == boundSite else { return false }
    if frameSite == boundSite { return true }
    guard let iframeDomain else { return false }
    return frameSite == VaultOriginMatch.registrableDomain(iframeDomain)
  }

  static func site(_ origin: String) -> String? {
    guard VaultOriginMatch.isWebOrigin(origin), let host = VaultOriginMatch.host(of: origin) else { return nil }
    let site = VaultOriginMatch.registrableDomain(host)
    return site.isEmpty ? nil : site
  }
}

struct VaultDeliveredRow: Sendable, Equatable {
  var id: String
  var source: VaultDeliveredSource
  var sender: String
  var site: String?
  var bound: Bool
  var receivedAt: Double
  var expiresAt: Double

  func jsonObject() -> [String: Any] {
    [
      "id": id, "source": source.rawValue, "sender": sender, "site": site.map { $0 as Any } ?? NSNull(), "bound": bound,
      "receivedAt": receivedAt, "expiresAt": expiresAt,
    ]
  }
}

struct VaultDeliveredState: Sendable, Equatable {
  var access: VaultDeliveredAccess
  var codes: [VaultDeliveredRow]

  func jsonObject() -> [String: Any] { ["access": access.rawValue, "codes": codes.map { $0.jsonObject() }] }
}

struct VaultDeliveredHooks: Sendable {
  var now: @Sendable () -> Date = { Date() }
  var announce: @Sendable (VaultDeliveredState) -> Void = { _ in }
  var read: @Sendable (VaultDeliveredPaths, Date) -> [VaultDeliveredRead] = { VaultDeliveredCodes.readAll($0, since: $1) }
  var watches = true
}

actor VaultDeliveredCodes {
  static let provider = "delivered"
  static let lifetime: TimeInterval = 300
  static let period = 300
  static let staleScan: TimeInterval = 2
  static let settle: Duration = .milliseconds(250)
  static let mostKept = 10
  static let accessPollEvery: Duration = .seconds(2)
  static let accessPollFor: TimeInterval = 180

  private let paths: VaultDeliveredPaths
  private let hooks: VaultDeliveredHooks
  private var enabled: Bool
  private var access: VaultDeliveredAccess
  private var entries: [VaultDeliveredCode] = []
  private var seen: [String: Date] = [:]
  private var lastScan: Date?
  private var announced: VaultDeliveredState?
  private var watcher: VaultDeliveredWatch?
  private var pendingScan: Task<Void, Never>?
  private var expiry: Task<Void, Never>?
  private var accessPoll: Task<Void, Never>?

  init(paths: VaultDeliveredPaths, hooks: VaultDeliveredHooks) {
    self.paths = paths
    self.hooks = hooks
    self.enabled = false
    self.access = .off
  }

  static func isId(_ id: String) -> Bool { id.hasPrefix("delivered.") && id.count <= 64 }

  func state(rescan: Bool) -> VaultDeliveredState {
    if rescan, enabled, lastScan.map({ hooks.now().timeIntervalSince($0) >= Self.staleScan }) ?? true { scan() }
    prune()
    return current()
  }

  func setEnabled(_ on: Bool) -> VaultDeliveredState {
    enabled = on
    if on {
      scan()
      watchForAccess()
    } else {
      stopAll()
      entries = []
      seen = [:]
      lastScan = nil
      access = .off
      publish()
    }
    return current()
  }

  func watchForAccess() {
    guard enabled, access == .needsAccess else { return }
    accessPoll?.cancel()
    let until = hooks.now().addingTimeInterval(Self.accessPollFor)
    accessPoll = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: Self.accessPollEvery)
        guard let self, await self.pollAccess(until: until) else { return }
      }
    }
  }

  func totp(id: String) -> VaultTotp? {
    prune()
    guard let entry = entries.first(where: { $0.id == id }) else { return nil }
    return VaultTotp(code: entry.code, period: Self.period, expiresAt: entry.expiresAt.timeIntervalSince1970 * 1000)
  }

  func fillCode(id: String, fields: [String], origin: String, top: String?, userChose: Bool) -> Result<String, VaultFillError> {
    guard VaultOriginMatch.isSecure(origin), top.map(VaultOriginMatch.isSecure) ?? true else { return .failure(.insecure) }
    guard !fields.isEmpty, fields.allSatisfy({ $0 == "otp" || $0 == "totp" }) else { return .failure(.notFound) }
    prune()
    guard let entry = entries.first(where: { $0.id == id }) else { return .failure(.notFound) }
    guard entry.fills(frame: origin, top: top, userChose: userChose) else { return .failure(.originMismatch) }
    return .success(entry.code)
  }

  func filled(id: String) {
    guard let index = entries.firstIndex(where: { $0.id == id }) else { return }
    entries.remove(at: index)
    publish()
  }

  func scan() {
    VaultOffMain.check()
    guard enabled else { return }
    let now = hooks.now()
    lastScan = now
    let reads = hooks.read(paths, now.addingTimeInterval(-Self.lifetime))
    access = reads.contains { $0.reach == .denied } ? .needsAccess : .on
    for message in reads.flatMap(\.messages) where seen[message.key] == nil {
      seen[message.key] = message.receivedAt
      take(message, now: now)
    }
    if hooks.watches { rewatch(reads.flatMap(\.watched)) }
    prune()
    publish()
  }

  private func take(_ message: VaultDeliveredMessage, now: Date) {
    let received = min(message.receivedAt, now)
    let expires = received.addingTimeInterval(Self.lifetime)
    guard expires > now else { return }
    guard let found = VaultDeliveredExtractor.extract(message.text, sender: message.sender, source: message.source) else { return }
    guard !entries.contains(where: { $0.code == found.code }) else { return }
    entries.append(VaultDeliveredCode(
      id: "delivered." + Self.randomToken(), source: message.source, sender: VaultDeliveredExtractor.cleanedSender(message.sender), site: found.site,
      boundDomain: found.boundDomain, iframeDomain: found.iframeDomain, code: found.code, receivedAt: received, expiresAt: expires,
      messageKey: message.key))
    entries.sort { $0.receivedAt > $1.receivedAt }
    if entries.count > Self.mostKept { entries.removeLast(entries.count - Self.mostKept) }
  }

  private func prune() {
    let now = hooks.now()
    let before = entries.count
    entries.removeAll { $0.expiresAt <= now }
    seen = seen.filter { now.timeIntervalSince($0.value) < Self.lifetime * 2 }
    if entries.count != before { publish() }
    planExpiry()
  }

  private func planExpiry() {
    expiry?.cancel()
    expiry = nil
    guard let next = entries.map(\.expiresAt).min() else { return }
    let wait = max(0, next.timeIntervalSince(hooks.now())) + 0.05
    expiry = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
      guard !Task.isCancelled else { return }
      await self?.expire()
    }
  }

  private func expire() { prune() }

  private func pollAccess(until: Date) -> Bool {
    guard enabled, access == .needsAccess, hooks.now() < until else { return false }
    scan()
    return access == .needsAccess
  }

  private func current() -> VaultDeliveredState {
    guard enabled else { return VaultDeliveredState(access: .off, codes: []) }
    let rows = entries.map {
      VaultDeliveredRow(
        id: $0.id, source: $0.source, sender: $0.sender, site: $0.site, bound: $0.bound, receivedAt: $0.receivedAt.timeIntervalSince1970 * 1000,
        expiresAt: $0.expiresAt.timeIntervalSince1970 * 1000)
    }
    return VaultDeliveredState(access: access, codes: rows)
  }

  private func publish() {
    let state = current()
    guard state != announced else { return }
    announced = state
    hooks.announce(state)
  }

  private func stopAll() {
    watcher?.stop()
    watcher = nil
    pendingScan?.cancel()
    pendingScan = nil
    expiry?.cancel()
    expiry = nil
    accessPoll?.cancel()
    accessPoll = nil
  }

  private func rewatch(_ files: [String]) {
    if let watcher, watcher.files == files, watcher.alive { return }
    watcher?.stop()
    watcher = VaultDeliveredWatch(files: files) { [weak self] in
      Task { await self?.changed() }
    }
  }

  private func changed() {
    guard enabled else { return }
    pendingScan?.cancel()
    pendingScan = Task { [weak self] in
      try? await Task.sleep(for: Self.settle)
      guard !Task.isCancelled else { return }
      await self?.scan()
    }
  }

  static func readAll(_ paths: VaultDeliveredPaths, since: Date) -> [VaultDeliveredRead] {
    var reads: [VaultDeliveredRead] = []
    if let messages = paths.messages { reads.append(VaultMessagesReader.read(messages, since: since)) }
    if let envelope = paths.mailEnvelope {
      reads.append(VaultMailReader.read(envelope, since: since))
    } else if let root = paths.mailRoot {
      let found = VaultMailReader.envelope(root: root)
      if let path = found.path {
        reads.append(VaultMailReader.read(path, since: since))
      } else {
        reads.append(found.reach == .denied ? .denied : .missing)
      }
    }
    return reads
  }

  static func randomToken() -> String {
    var generator = SystemRandomNumberGenerator()
    return (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
  }
}

final class VaultDeliveredWatch: @unchecked Sendable {
  let files: [String]
  private let queue = DispatchQueue(label: "ardia.vaults.delivered.watch", qos: .utility)
  private let lock = NSLock()
  private var sources: [DispatchSourceFileSystemObject] = []
  private var broken = false

  init(files: [String], onChange: @escaping @Sendable () -> Void) {
    self.files = files
    for file in files {
      let descriptor = open(file, O_EVTONLY | O_CLOEXEC)
      guard descriptor >= 0 else { continue }
      let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: [.write, .extend, .delete, .rename, .revoke], queue: queue)
      source.setEventHandler { [weak self, weak source] in
        let gone = source.map { !$0.data.isDisjoint(with: [.delete, .rename, .revoke]) } ?? false
        if gone { self?.markBroken() }
        onChange()
      }
      source.setCancelHandler { close(descriptor) }
      source.resume()
      sources.append(source)
    }
  }

  var alive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !broken && sources.count == files.count
  }

  func stop() {
    lock.lock()
    let running = sources
    sources = []
    lock.unlock()
    for source in running { source.cancel() }
  }

  private func markBroken() {
    lock.lock()
    broken = true
    lock.unlock()
  }

  deinit { for source in sources { source.cancel() } }
}
