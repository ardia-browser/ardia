@preconcurrency import ArdiaSyncCore
import Foundation

public enum SyncDestination: Equatable, Sendable {
  case folder(URL)
  case nextcloud(NextcloudAccount, path: String?)
}

public struct SyncConnectFlow: Equatable, Sendable {
  public struct Attempt: Equatable, Sendable {
    public let phrase: String
    public let destination: SyncDestination

    init(phrase: String, destination: SyncDestination) {
      self.phrase = phrase
      self.destination = destination
    }

    init(phrase: String, folder: URL) {
      self.init(phrase: phrase, destination: .folder(folder))
    }
  }

  public private(set) var phrase = ""
  public private(set) var destination: SyncDestination?
  public private(set) var failure: String?
  public private(set) var isConnecting = false
  private var attempting: Data?
  private var attemptingDestination: SyncDestination?
  private var held: NextcloudAccount?
  private var released: [NextcloudAccount] = []

  public init() {}

  public var hasPhrase: Bool { Self.entropy(of: phrase) != nil }

  public mutating func enterPhrase(_ text: String) -> Attempt? {
    let before = Self.entropy(of: phrase)
    phrase = text
    guard Self.entropy(of: text) != before else { return nil }
    failure = nil
    return startIfReady()
  }

  public var folder: URL? {
    if case .folder(let url) = destination { return url }
    return nil
  }

  public var nextcloud: NextcloudAccount? {
    if case .nextcloud(let account, _) = destination { return account }
    return nil
  }

  public mutating func chooseFolder(_ url: URL) -> Attempt? {
    choose(.folder(url))
  }

  public mutating func choose(_ destination: SyncDestination) -> Attempt? {
    let chosen = Self.account(of: destination)
    if let held, held != chosen { released.append(held) }
    held = chosen
    self.destination = destination
    failure = nil
    return startIfReady()
  }

  public mutating func finish(_ result: ConnectResult) -> Attempt? {
    let tried = attempting
    let triedDestination = attemptingDestination
    isConnecting = false
    attempting = nil
    attemptingDestination = nil
    if result == .connected {
      if let joined = triedDestination.flatMap(Self.account(of:)), joined == held { held = nil }
      phrase = ""
      failure = nil
      return nil
    }
    guard tried == Self.entropy(of: phrase) else { return startIfReady() }
    failure = result.message
    return nil
  }

  private mutating func startIfReady() -> Attempt? {
    guard !isConnecting, let destination, let entropy = Self.entropy(of: phrase) else { return nil }
    isConnecting = true
    attempting = entropy
    attemptingDestination = destination
    failure = nil
    return Attempt(phrase: phrase, destination: destination)
  }

  public mutating func takeReleased() -> [NextcloudAccount] {
    defer { released = [] }
    return released
  }

  public mutating func abandon() -> [NextcloudAccount] {
    defer {
      released = []
      held = nil
      if nextcloud != nil { destination = nil }
    }
    return released + (held.map { [$0] } ?? [])
  }

  private static func account(of destination: SyncDestination) -> NextcloudAccount? {
    if case .nextcloud(let account, _) = destination { return account }
    return nil
  }

  private static func entropy(of phrase: String) -> Data? {
    try? RecoveryPhrase.entropy(from: phrase)
  }
}
