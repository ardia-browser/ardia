import Foundation

final class PluginCertificateCache {
  static let preparationLimit: TimeInterval = 3

  private let queue = DispatchQueue(label: "ardia.plugins.certificates", qos: .userInitiated, attributes: .concurrent)
  private let lock = NSLock()
  private var cached: (key: [String: String], identities: [String: PluginSandbox.SourceIdentity], value: PluginSandbox.Certificates)?
  private var inFlight: [[String: String]: [UUID: (PluginSandbox.Certificates) -> Void]] = [:]
  private(set) var loadsStarted = 0
  var willLoad: (() -> Void)?
  private let system: String

  init(system: String = PluginSandbox.systemCertificates) {
    self.system = system
  }

  static func key(of given: [String: String]) -> [String: String] {
    given.filter { PluginSandbox.certificateEnvironment.contains($0.key) }
  }

  func load(_ key: [String: String]) -> PluginSandbox.Certificates {
    lock.lock()
    let previous = cached
    lock.unlock()
    if let previous, previous.key == key, previous.identities.allSatisfy({ PluginSandbox.identity(of: $0.key) == $0.value }) {
      return previous.value
    }
    let loaded = PluginSandbox.loadCertificates(from: key, system: system)
    lock.lock()
    cached = loaded.complete ? (key, loaded.identities, loaded.certificates) : nil
    lock.unlock()
    return loaded.certificates
  }

  func prepare(
    for given: [String: String], within limit: TimeInterval = preparationLimit, deliverOn target: DispatchQueue,
    then: @escaping (PluginSandbox.PreparedCertificates) -> Void
  ) {
    let key = Self.key(of: given)
    guard !PluginSandbox.extraCertificateSources(from: key, system: system).isEmpty else {
      target.async { then(.notConfigured) }
      return
    }
    let answer = PluginAnswerOnce()
    let waiter = UUID()
    target.asyncAfter(deadline: .now() + limit) { [self] in
      guard answer.claim() else { return }
      lock.lock()
      inFlight[key]?[waiter] = nil
      lock.unlock()
      then(.timedOut)
    }
    let deliver = { (value: PluginSandbox.Certificates) in
      target.async {
        if answer.claim() { then(.ready(value)) }
      }
    }
    lock.lock()
    if inFlight[key] != nil {
      inFlight[key]?[waiter] = deliver
      lock.unlock()
      return
    }
    inFlight[key] = [waiter: deliver]
    loadsStarted += 1
    let hook = willLoad
    lock.unlock()
    queue.async { [self] in
      hook?()
      let value = load(key)
      lock.lock()
      let waiting = inFlight.removeValue(forKey: key) ?? [:]
      lock.unlock()
      for answer in waiting.values { answer(value) }
    }
  }

  func waiting(for given: [String: String]) -> Int {
    lock.lock()
    defer { lock.unlock() }
    return inFlight[Self.key(of: given)]?.count ?? 0
  }
}

final class PluginAnswerOnce {
  private let lock = NSLock()
  private var answered = false

  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if answered { return false }
    answered = true
    return true
  }
}
