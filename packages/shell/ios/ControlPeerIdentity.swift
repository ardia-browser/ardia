import Darwin
import Foundation

struct ControlPeerIdentity {
  let token: audit_token_t
  var verified: (peer: ControlPeer, lookupMs: Double)?

  static func resolve(_ token: audit_token_t) -> (peer: ControlPeer, lookupMs: Double) {
    let started = DispatchTime.now().uptimeNanoseconds
    let peer = ControlPeer.resolve(token)
    return (peer, Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
  }

  static func reply(_ verified: (peer: ControlPeer, lookupMs: Double)) -> [String: Any] {
    let peer = verified.peer
    var found: [String: Any] = ["pid": Int(peer.pid), "signed": false, "valid": false, "adhoc": false, "platform": false, "lookupMs": verified.lookupMs]
    if let path = peer.path { found["path"] = path }
    if let identifier = peer.identifier { found["identifier"] = identifier }
    if peer.path != nil || peer.identifier != nil || peer.bundleName != nil { found["name"] = peer.name }
    switch peer.signer {
    case let .team(team):
      found["teamId"] = team
      found["signed"] = true
      found["valid"] = true
      if let developer = peer.developer, !developer.isEmpty { found["signer"] = "\(ControlPeer.plain(developer, limit: 80)) (\(team))" }
    case .apple:
      found["signed"] = true
      found["valid"] = true
      found["platform"] = true
      found["signer"] = "Apple"
    case .other:
      break
    }
    return found
  }
}
