import Foundation

struct CredentialHandles: Sendable {
  enum Kind: Sendable, Equatable {
    case typed
    case session
    case stored
  }

  struct Handle: Sendable, Equatable {
    let id: String
    let kind: Kind
    let value: String
    let call: String
    let epoch: String
    var launches = 0
    var spent = false
  }

  private(set) var handles: [String: Handle] = [:]
  private var next = 0

  var allValues: [String] { handles.values.map(\.value) }

  func count(in call: String) -> Int { handles.values.filter { $0.call == call }.count }

  mutating func mint(_ value: String, kind: Kind, call: String, epoch: String) -> String? {
    guard count(in: call) < CredentialLimits.handlesPerCall, value.utf8.count <= CredentialLimits.secretBytes else { return nil }
    next += 1
    let id = "h\(next)"
    handles[id] = Handle(id: id, kind: kind, value: value, call: call, epoch: epoch)
    return id
  }

  func live(_ id: String, call: String, epoch: String) -> Handle? {
    guard let handle = handles[id], !handle.spent, handle.call == call, handle.epoch == epoch else { return nil }
    return handle
  }

  func value(_ id: String, call: String, epoch: String) -> String? { live(id, call: call, epoch: epoch)?.value }

  mutating func launched(_ ids: [String]) {
    for id in Set(ids) {
      guard var handle = handles[id], handle.kind == .typed else { continue }
      handle.launches += 1
      if handle.launches >= CredentialLimits.typedSecretLaunches { handle.spent = true }
      handles[id] = handle
    }
  }

  mutating func exited(_ ids: [String], succeeded: Bool) {
    guard succeeded else { return }
    for id in Set(ids) where handles[id]?.kind == .typed { handles[id]?.spent = true }
  }

  mutating func endCall(_ call: String) {
    handles = handles.filter { $0.value.call != call }
  }

  mutating func endAll() { handles.removeAll() }

  func values(in call: String) -> [String] { handles.values.filter { $0.call == call }.map(\.value) }
}
