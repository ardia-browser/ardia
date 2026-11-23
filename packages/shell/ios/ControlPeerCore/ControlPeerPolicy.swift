import Foundation

public enum ControlPeerVerdict: Equatable {
  case ardia
  case sameUser
  case approved(String)
  case ask(String?)
}

public enum ControlPeerDecision: String, CaseIterable {
  case once
  case halfHour
  case always
  case deny

  public static let halfHourSeconds: TimeInterval = 30 * 60

  public func approval(for peer: ControlPeer, key: String, now: Date) -> ControlApproval? {
    switch self {
    case .halfHour: return ControlApproval(peer: peer, key: key, added: now, until: now.addingTimeInterval(Self.halfHourSeconds))
    case .always: return ControlApproval(peer: peer, key: key, added: now, until: nil)
    case .once, .deny: return nil
    }
  }
}

public struct ControlPeerPolicy {
  public let ownTeam: String?
  public let sameUserIsEnough: Bool

  public init(ownTeam: String?, sameUserIsEnough: Bool) {
    self.ownTeam = ownTeam
    self.sameUserIsEnough = sameUserIsEnough
  }

  public static func ownTeam(of me: ControlPeer) -> String? {
    if case let .team(team) = me.signer { return team }
    return nil
  }

  public func verdict(_ peer: ControlPeer, approvals: [ControlApproval], now: Date) -> ControlPeerVerdict {
    if sameUserIsEnough { return .sameUser }
    if let ownTeam, case let .team(team) = peer.signer, team == ownTeam, peer.hardened { return .ardia }
    let key = peer.approvalKey
    if let key, approvals.contains(where: { $0.key == key && $0.live(at: now) }) { return .approved(key) }
    return .ask(key)
  }
}
