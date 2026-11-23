import ArdiaCoreRS
import Foundation

public final class SyncKeys: @unchecked Sendable {
  public enum Failure: Error, Equatable {
    case format
    case authentication
    case random
  }

  public static let backend = "rust"
  public static var consentEpoch: () -> String = { "" }

  private let handle: OpaquePointer
  public let chainTag: String

  public init(entropy: Data) {
    precondition(entropy.count == RecoveryPhrase.entropyBytes, "sync entropy must be \(RecoveryPhrase.entropyBytes) bytes")
    var made: OpaquePointer?
    let status = CoreCall.bytes(entropy) { ardia_sync_keys_new($0, $1, &made) }
    guard status == ARDIA_STATUS_OK, let made else { preconditionFailure("ardia_sync_keys_new refused 32 bytes of entropy: \(status.rawValue)") }
    handle = made
    chainTag = CoreCall.text { ardia_sync_chain_tag(made, $0) }
  }

  deinit { ardia_sync_keys_free(handle) }

  public func scopeTag(_ scope: String) throws -> String {
    try CoreCall.string { out in CoreCall.bytes(scope) { ardia_sync_scope_tag(handle, $0, $1, out) } }
  }

  public func seal(_ payload: Data, scopeTag: String, fileId: String) throws -> Data {
    try CoreCall.mapped { out in
      CoreCall.bytes(payload) { payload, payloadCount in
        CoreCall.bytes(scopeTag) { tag, tagCount in
          CoreCall.bytes(fileId) { id, idCount in ardia_sync_seal(handle, payload, payloadCount, tag, tagCount, id, idCount, out) }
        }
      }
    }
  }

  public func open(_ file: Data, scopeTag: String, fileId: String) throws -> Data {
    let startedIn = Self.consentEpoch()
    do {
      return try CoreCall.data { out in
        CoreCall.bytes(file) { file, fileCount in
          CoreCall.bytes(scopeTag) { tag, tagCount in
            CoreCall.bytes(fileId) { id, idCount in ardia_sync_open(handle, file, fileCount, tag, tagCount, id, idCount, out) }
          }
        }
      }
    } catch let failure as CoreCall.Refused {
      OpenFailures.note(failure.status, startedIn: startedIn)
      throw failure.syncFailure
    }
  }

  public func sealPassword(_ password: String, origin: String, username: String) throws -> String {
    try CoreCall.string { out in
      CoreCall.bytes(password) { password, passwordCount in
        CoreCall.bytes(origin) { origin, originCount in
          CoreCall.bytes(username) { username, usernameCount in
            ardia_sync_seal_password(handle, password, passwordCount, origin, originCount, username, usernameCount, out)
          }
        }
      }
    }
  }

  public func openPassword(_ sealed: String, origin: String, username: String) throws -> String {
    try CoreCall.string { out in
      CoreCall.bytes(sealed) { sealed, sealedCount in
        CoreCall.bytes(origin) { origin, originCount in
          CoreCall.bytes(username) { username, usernameCount in
            ardia_sync_open_password(handle, sealed, sealedCount, origin, originCount, username, usernameCount, out)
          }
        }
      }
    }
  }

  public static func newFileId() -> String {
    CoreCall.text { ardia_sync_new_file_id($0) }
  }

  public static func takeOpenFailures() -> [String: Int] { OpenFailures.take() }
}

enum Base32 {
  static let alphabet = Set("abcdefghijklmnopqrstuvwxyz234567")

  static func isTag(_ name: String) -> Bool {
    name.count == 26 && name.allSatisfy { alphabet.contains($0) }
  }
}

enum OpenFailures {
  private static let lock = NSLock()
  private static var counts: [String: Int] = [:]
  private static var countedEpoch = ""

  static func note(_ status: ardia_status, startedIn epoch: String) {
    let code: String
    switch status {
    case ARDIA_STATUS_FORMAT: code = "format"
    case ARDIA_STATUS_AUTHENTICATION: code = "authentication"
    case ARDIA_STATUS_TOO_LARGE: code = "too_large"
    default: code = "other"
    }
    guard !epoch.isEmpty, epoch == SyncKeys.consentEpoch() else { return }
    lock.lock()
    defer { lock.unlock() }
    if epoch != countedEpoch {
      counts = [:]
      countedEpoch = epoch
    }
    counts[code, default: 0] += 1
  }

  static func take() -> [String: Int] {
    let epoch = SyncKeys.consentEpoch()
    lock.lock()
    defer { lock.unlock() }
    let taken = !epoch.isEmpty && epoch == countedEpoch ? counts : [:]
    counts = [:]
    return taken
  }
}

enum CoreCall {
  struct Refused: Error {
    let status: ardia_status
    let detail: [String: Any]

    var syncFailure: SyncKeys.Failure {
      switch status {
      case ARDIA_STATUS_AUTHENTICATION: .authentication
      case ARDIA_STATUS_RANDOM: .random
      default: .format
      }
    }
  }

  static func bytes<T>(_ data: Data, _ body: (UnsafePointer<UInt8>?, Int) -> T) -> T {
    data.withUnsafeBytes { body($0.bindMemory(to: UInt8.self).baseAddress, $0.count) }
  }

  static func bytes<T>(_ text: String, _ body: (UnsafePointer<UInt8>?, Int) -> T) -> T {
    var text = text
    return text.withUTF8 { body($0.baseAddress, $0.count) }
  }

  static func data(_ call: (UnsafeMutablePointer<ardia_buf>) -> ardia_status) throws -> Data {
    var buffer = ardia_buf(ptr: nil, len: 0)
    let status = call(&buffer)
    guard status == ARDIA_STATUS_OK else {
      defer { ardia_buf_free(&buffer) }
      let detail = buffer.ptr.map { Data(bytes: $0, count: buffer.len) } ?? Data()
      throw Refused(status: status, detail: (try? JSONSerialization.jsonObject(with: detail)) as? [String: Any] ?? [:])
    }
    guard let bytes = buffer.ptr else { return Data() }
    return Data(bytesNoCopy: bytes, count: buffer.len, deallocator: .custom { pointer, count in
      var owned = ardia_buf(ptr: pointer.assumingMemoryBound(to: UInt8.self), len: count)
      ardia_buf_free(&owned)
    })
  }

  static func mapped(_ call: (UnsafeMutablePointer<ardia_buf>) -> ardia_status) throws -> Data {
    do {
      return try data(call)
    } catch let failure as Refused {
      throw failure.syncFailure
    }
  }

  static func string(_ call: (UnsafeMutablePointer<ardia_buf>) -> ardia_status) throws -> String {
    let bytes = try mapped(call)
    let text = String(decoding: bytes, as: UTF8.self)
    guard text.utf8.elementsEqual(bytes) else { throw SyncKeys.Failure.format }
    return text
  }

  static func text(_ call: (UnsafeMutablePointer<ardia_buf>) -> ardia_status) -> String {
    do {
      return try string(call)
    } catch {
      preconditionFailure("the sync core refused a call that can't fail: \(error)")
    }
  }
}
