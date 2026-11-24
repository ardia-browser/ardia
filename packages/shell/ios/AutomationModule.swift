import ExpoModulesCore
import Foundation

public class AutomationModule: Module, AutomationNative {
  static func start(_ promise: Promise) { ControlSocket.shared.start { promise.resolve($0) } }

  static func stop(_ promise: Promise) { ControlSocket.shared.stop { promise.resolve(nil) } }

  static func reply(_ connection: Int, _ line: String, _ ticket: Int) { ControlSocket.shared.reply(connection, line, ticket: ticket) }

  static func cutOff() -> Bool { ControlSocket.shared.cutOff() }

  static func broadcast(_ connections: [Int], _ line: String) { ControlSocket.shared.broadcast(connections, line) }

  static func devtoolsEndpoint(_ connection: Int, _ promise: Promise) { ControlSocket.shared.devtoolsEndpoint(connection) { promise.resolve($0) } }

  static func answerPeer(_ ask: Int, _ outcome: String, _ promise: Promise) { ControlSocket.shared.answerPeer(ask, outcome) { promise.resolve($0) } }

  static func approvals(_ promise: Promise) { ControlSocket.shared.approvals { promise.resolve($0) } }

  static func revokeApproval(_ key: String, _ promise: Promise) { ControlSocket.shared.revokeApproval(key) { promise.resolve($0) } }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.eventsDefinition

    OnCreate {
      ControlSocket.shared.attach(self) { [weak self] name, body in self?.sendEvent(name, body) }
    }

    Self.startFunction

    Self.stopFunction

    Self.replyFunction

    Self.cutOffFunction

    Self.broadcastFunction

    Self.devtoolsEndpointFunction

    Self.answerPeerFunction

    Self.approvalsFunction

    Self.revokeApprovalFunction

    OnDestroy {
      ControlSocket.shared.detach(self)
    }
  }
}
