import Foundation

struct CredentialContribution: Sendable, Equatable {
  var plugin: String
  var title: String
  var symbol: String?
  var icon: String?
  var accent: String?
  var readsOffline: Bool
  var approvalLastsSeconds: Int?
  var capabilities: [String]
  var signIn: CredentialSignInSpec
  var cli: CredentialCliSpec
  var memoryMB: Int

  func offers(_ capability: String) -> Bool { capabilities.contains(capability) }
}

struct CredentialSignInSpec: Sendable, Equatable {
  enum Kind: String, Sendable {
    case fields
    case desktopApproval
    case browserApproval
  }

  struct Field: Sendable, Equatable {
    enum FieldType: String, Sendable {
      case text
      case email
      case secret
    }

    var id: String
    var title: String
    var type: FieldType
    var placeholder: String?
    var hint: String?
    var optional: Bool
    var prefillsAccount: Bool
    var masked: Bool
  }

  struct Method: Sendable, Equatable {
    var id: String
    var title: String
    var kind: Kind
    var fields: [Field]
    var twoStep: Bool
    var appURL: String?
    var appTitle: String?
  }

  struct Server: Sendable, Equatable {
    var id: String
    var title: String
    var customTitle: String?
    var customPlaceholder: String?

    var isCustom: Bool { customTitle != nil }
  }

  var methods: [Method]
  var servers: [Server]
  var unlockField: String?
  var approvalHosts: [String]

  func field(_ id: String) -> Field? {
    for method in methods { if let found = method.fields.first(where: { $0.id == id }) { return found } }
    return nil
  }

  func method(_ id: String) -> Method? { methods.first { $0.id == id } }
}

struct CredentialCliSpec: Sendable, Equatable {
  struct Install: Sendable, Equatable {
    var command: String
    var update: String?
    var url: String
  }

  struct OnLock: Sendable, Equatable {
    enum Source: Sendable, Equatable {
      case session
      case preference(String)
      case literal(String)
    }

    var verb: String
    var params: [String: Source]
    var skipWithTouchID: Bool
  }

  var name: String
  var install: Install
  var minimumVersion: String?
  var patterns: [String: String]
  var env: [CredentialEnvEntry]
  var onLock: OnLock?
  var verbs: [String: CredentialVerb]
  var verbOrder: [String]

  func verb(_ id: String) -> CredentialVerb? { verbs[id] }
}

struct CredentialEnvEntry: Sendable, Equatable {
  enum Source: Sendable, Equatable {
    case literal(String)
    case secretSlot(String)
    case testFolder(String)
    case testLiteral(String)
  }

  var name: String
  var source: Source
}

struct CredentialVerb: Sendable, Equatable {
  enum Element: Sendable, Equatable {
    case token(String)
    case slot(String)
    case flagSlot(flag: String, slot: String)
    case flagWhen(flag: String, slot: String)
  }

  enum SlotType: Sendable, Equatable {
    case id(pattern: String)
    case choice([String])
    case flag
    case url(allowLocalHttp: Bool)
    case email
    case code
    case secret
    case json

    var name: String {
      switch self {
      case .id: return "id"
      case .choice: return "enum"
      case .flag: return "flag"
      case .url: return "url"
      case .email: return "email"
      case .code: return "code"
      case .secret: return "secret"
      case .json: return "json"
      }
    }
  }

  struct Slot: Sendable, Equatable {
    var type: SlotType
    var optional: Bool
  }

  struct Stdin: Sendable, Equatable {
    var slot: String
    var base64: Bool
  }

  enum Output: Sendable, Equatable {
    case json(items: String?)
    case lines
    case lastLineSecret
    case stream
  }

  enum Unlocks: Sendable, Equatable {
    case no
    case yes
    case persistent
  }

  var id: String
  var argv: [Element]
  var slots: [String: Slot]
  var env: [CredentialEnvEntry]
  var stdin: Stdin?
  var timeoutMs: Int
  var outputLimitBytes: Int
  var output: Output
  var signIn: Bool
  var unlocks: Unlocks
  var outlivesCall: Bool
  var hints: [String: [String]]
  var hintOrder: [String]

  var leadingWords: [String] {
    var words: [String] = []
    for element in argv {
      guard case .token(let token) = element, !token.hasPrefix("-") else { break }
      words.append(token)
    }
    return words
  }
}
