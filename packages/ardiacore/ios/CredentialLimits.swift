import Foundation

enum CredentialLimits {
  static let protocolVersion = 1
  static let supportedProtocols = [1]
  static let pluginProtocol = 2
  static let callKind = "credentials"

  static let resultBytes = 1 << 20
  static let listedItems = 50_000
  static let listPages = 1_000
  static let pageCursorLength = 256
  static let itemIdLength = 512
  static let itemTitleLength = 1024
  static let usernameLength = 1024
  static let passwordLength = 4096
  static let urlLength = 2048
  static let urlsPerItem = 64
  static let vaultNameLength = 256
  static let passkeysPerItem = 16
  static let passkeyNameLength = 256
  static let accountLength = 320
  static let detailLength = 240
  static let choices = 16
  static let choiceTitleLength = 60
  static let waitingCalls = 8
  static let runningVerbs = 4
  static let verbParams = 16
  static let idSlotLength = 512
  static let enumValueLength = 64
  static let emailSlotLength = 320
  static let urlSlotLength = 2048
  static let stdinBytes = 4 << 20
  static let stdinJsonDepth = 32
  static let defaultOutputBytes = 32 << 20
  static let leastOutputBytes = 1024
  static let mostOutputBytes = 160 << 20
  static let outputItemBytes = 1 << 20
  static let stderrBytes = 64 << 10
  static let chunkBytes = 256 << 10
  static let inlineReplyBytes = 960 << 10
  static let streamLineBytes = 16 << 10
  static let streamLinesPerSecond = 200
  static let handlesPerCall = 16
  static let secretBytes = 4096
  static let typedSecretLaunches = 3
  static let valueKeys = 16
  static let valueBytes = 1024
  static let ownerReasonLength = 60
  static let snapshotLength = 64
  static let lastLineSecretShortest = 16
  static let redactedShortest = 3
  static let stdinRedactedShortest = 6
  static let callContextLinger: TimeInterval = 15
  static let listingDeadline: TimeInterval = 900
  static let onLockDeadline: TimeInterval = 20
  static let runWait: TimeInterval = 20
  static let memoryMB = (least: 256, standard: 1024, most: 4096)

  static let deadlines: [String: TimeInterval] = [
    "state": 45, "signIn": 180, "unlock": 120, "signOut": 30, "configure": 60, "list": 240, "reveal": 90, "save": 300, "edit": 300,
    "addTotp": 300, "passkeys.list": 120, "passkeys.get": 90, "passkeys.save": 300,
  ]

  static let verbTimeout = (standard: 30_000, least: 1_000, most: 900_000)

  static let handlers = [
    "state", "signIn", "unlock", "signOut", "configure", "list", "reveal", "save", "edit", "addTotp", "passkeys.list", "passkeys.get", "passkeys.save",
  ]
  static let requiredHandlers = ["state", "signIn", "unlock", "signOut", "list", "reveal"]

  static let capabilities = ["totp", "save", "edit", "addTotp", "passkeys", "selfHosted", "masterPassword", "touchID"]
  static let capabilityHandlers: [String: [[String]]] = [
    "save": [["save"]], "edit": [["edit"]], "addTotp": [["addTotp"], ["edit"]], "passkeys": [["passkeys.get", "passkeys.save"]],
    "selfHosted": [["configure"]],
  ]

  static let deniedEnvPatterns = ["DYLD_*", "LD_*", "NODE_*", "*_PROXY", "SSL_*", "NODE_TLS_*", "HOME", "PATH", "TMPDIR", "XDG_*", "OP_CONNECT_*", "BITWARDENCLI_*"]
  static let hostEnv = [
    "HOME", "USER", "LOGNAME", "TMPDIR", "PATH", "LANG", "http_proxy", "https_proxy", "no_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
  ]
  static let claimedPrograms = ["op", "bw", "pass-cli", "node"]

  struct DeniedCommand: Sendable {
    let argv: [String]
    let withFlag: String?
    let why: String
  }

  static let deniedCommands: [String: [DeniedCommand]] = [
    "op": [
      DeniedCommand(argv: ["run"], withFlag: nil, why: "it runs other programs"),
      DeniedCommand(argv: ["inject"], withFlag: nil, why: "it runs other programs"),
      DeniedCommand(argv: ["plugin"], withFlag: nil, why: "it runs other programs"),
      DeniedCommand(argv: ["read"], withFlag: "--out-file", why: "it writes files"),
      DeniedCommand(argv: ["document", "get"], withFlag: "--out-file", why: "it writes files"),
      DeniedCommand(argv: ["service-account"], withFlag: nil, why: "it mints credentials"),
    ],
    "bw": [
      DeniedCommand(argv: ["serve"], withFlag: nil, why: "it opens a server"),
      DeniedCommand(argv: ["send"], withFlag: nil, why: "it shares data"),
      DeniedCommand(argv: ["export"], withFlag: nil, why: "it writes files"),
      DeniedCommand(argv: ["encode"], withFlag: nil, why: "it writes files"),
      DeniedCommand(argv: ["get", "attachment"], withFlag: nil, why: "it writes files"),
    ],
    "pass-cli": [
      DeniedCommand(argv: ["run"], withFlag: nil, why: "it runs other programs"),
      DeniedCommand(argv: ["inject"], withFlag: nil, why: "it runs other programs"),
      DeniedCommand(argv: ["ssh-agent"], withFlag: nil, why: "it opens an agent"),
    ],
  ]

  static let globalFlags: [String: [String]] = [
    "op": ["--account", "--config", "--encoding", "--format", "--iso-timestamps", "--no-color", "--session", "--cache", "--debug"],
    "bw": ["--nointeraction", "--raw", "--pretty", "--response", "--cleanexit", "--quiet", "--session"],
    "pass-cli": ["--output", "--quiet", "--verbose"],
  ]

  static let globalFlagsTakingValues: [String: Set<String>] = [
    "op": ["--account", "--config", "--encoding", "--format", "--session"],
    "bw": ["--session"],
    "pass-cli": ["--output"],
  ]

  static func deadline(_ handler: String) -> TimeInterval { deadlines[handler] ?? 60 }

  static func isDeniedEnvName(_ name: String) -> String? {
    deniedEnvPatterns.first { pattern in
      if pattern.hasPrefix("*") { return name.hasSuffix(String(pattern.dropFirst())) }
      if pattern.hasSuffix("*") { return name.hasPrefix(String(pattern.dropLast())) }
      return name == pattern
    }
  }
}
