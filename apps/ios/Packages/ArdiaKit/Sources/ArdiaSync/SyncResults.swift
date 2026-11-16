@preconcurrency import ArdiaSyncCore
import Foundation

public struct PhraseCheck: Equatable, Sendable {
  public var wordCount: Int
  public var counterText: String
  public var isTooLong: Bool
  public var problem: String?
  public var isValid: Bool
}

public enum PinOutcome: Equatable, Sendable {
  case pinned
  case alreadyPinned
  case failed
}

public enum ConnectResult: Equatable, Sendable {
  case connected
  case invalidPhrase(String)
  case mismatch
  case noSyncData
  case folderUnavailable
  case keychainFailed
  case busy
  case serverUnavailable
  case signInNeeded
  case insecureServer
  case noSyncDataInNextcloud
  case nextcloudFolderNotFound

  public var message: String? {
    switch self {
    case .connected: nil
    case .invalidPhrase(let message): message
    case .mismatch: "This recovery phrase doesn’t match the synced data in this folder. Check the phrase, or choose the folder your other devices sync to."
    case .noSyncData: "There’s no synced data in this folder yet. Choose the folder your other devices sync to, or wait for it to finish downloading."
    case .folderUnavailable: "Ardia can’t open this folder. Choose the Ardia Sync folder in iCloud Drive, or tap Use Nextcloud if your Mac syncs through Nextcloud."
    case .keychainFailed: "Couldn’t save the sync key in your Keychain."
    case .busy: "Ardia is still turning off sync. Try again in a moment."
    case .serverUnavailable: "Ardia can’t reach your Nextcloud server. Check your connection and try again."
    case .signInNeeded: "Sign in to Nextcloud again."
    case .insecureServer: "Ardia couldn’t make a secure connection to your Nextcloud server. It needs https with a valid certificate."
    case .noSyncDataInNextcloud: "Ardia couldn’t find your Mac’s sync data in Nextcloud. Type the folder your Mac syncs to, like Ardia Sync."
    case .nextcloudFolderNotFound: NextcloudProblem.folderNotFound.message
    }
  }

  init(_ problem: NextcloudProblem) {
    switch problem {
    case .insecure, .certificate: self = .insecureServer
    case .signInNeeded: self = .signInNeeded
    case .folderNotFound: self = .nextcloudFolderNotFound
    case .unreachable, .notNextcloud, .refused: self = .serverUnavailable
    }
  }
}

extension SyncService {
  static let resetMessage = "This device is out of sync. Sync may have been reset from another device."
  static let stalledMessage = "Ardia couldn’t read or write the sync folder. It will try again."
  static let unavailableMessage = "Ardia can’t read its sync data right now. It will try again."

  static func message(for problem: RecoveryPhrase.Problem) -> String {
    switch problem {
    case .wordCount: "Recovery phrase must be exactly 24 words."
    case .unknownWord(let word): "“\(word)” is not a valid recovery phrase word."
    case .checksum: "This recovery phrase is not valid. Please check for typos."
    }
  }

  static func waitingForDownloads(_ count: Int) -> String {
    String(AttributedString(localized: "Waiting for ^[\(count) file](inflect: true) to download").characters)
  }
}
