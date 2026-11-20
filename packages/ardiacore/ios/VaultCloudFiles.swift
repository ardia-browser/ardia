import CryptoKit
import Foundation

enum VaultCloudMerge: Equatable, Sendable {
  case keep
  case push(Data)
  case newerFormat
}

enum VaultCloudCopy: Equatable, Sendable {
  case opened(Data, current: Bool)
  case unknownKey
  case newerFormat
  case damaged
}

enum VaultCloudFiles {
  static let suffix = ".vault"
  static let placeholderSuffix = ".icloud"

  static func name(ofFile file: String) -> String? {
    var base = file
    if base.hasPrefix("."), base.hasSuffix(placeholderSuffix) {
      base = String(base.dropFirst().dropLast(placeholderSuffix.count))
    }
    guard base.hasSuffix(suffix), !base.hasPrefix(".") else { return nil }
    let name = String(base.dropLast(suffix.count))
    return name.isEmpty || name.contains("/") ? nil : name
  }

  static func classify(_ sealed: Data, keys: [SymmetricKey], context: String) -> VaultCloudCopy {
    if VaultSealed.isNewerFormat(sealed) { return .newerFormat }
    switch VaultSealed.open(sealed, keys: keys, context: context) {
    case .opened(let plain, let current): return .opened(plain, current: current)
    case .unknownKey: return .unknownKey
    case .corrupt: return .damaged
    }
  }

  static func isPlaceholder(_ file: String) -> Bool { file.hasPrefix(".") && file.hasSuffix(placeholderSuffix) }

  static func holdsSealedFiles(_ files: [String], head: (String) -> Data?) -> Bool {
    files.contains { file in
      guard name(ofFile: file) != nil else { return false }
      if isPlaceholder(file) { return true }
      return head(file).map(VaultSealed.isWellFormed) ?? true
    }
  }
}
