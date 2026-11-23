import ExpoModulesCore
import Foundation

public class AutomationModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaAutomation")

    Events("onRequest", "onClose", "onWritten", "onPeerAsk", "onPeerAskEnded")

    OnCreate {
      ControlSocket.shared.attach(self) { [weak self] name, body in self?.sendEvent(name, body) }
    }

    AsyncFunction("start") { (promise: Promise) in
      ControlSocket.shared.start { promise.resolve($0) }
    }

    AsyncFunction("stop") { (promise: Promise) in
      ControlSocket.shared.stop { promise.resolve(nil) }
    }

    Function("reply") { (connection: Int, line: String, ticket: Int) in
      ControlSocket.shared.reply(connection, line, ticket: ticket)
    }

    Function("cutOff") { () -> Bool in
      ControlSocket.shared.cutOff()
    }

    Function("broadcast") { (connections: [Int], line: String) in
      ControlSocket.shared.broadcast(connections, line)
    }

    AsyncFunction("devtoolsEndpoint") { (connection: Int, promise: Promise) in
      ControlSocket.shared.devtoolsEndpoint(connection) { promise.resolve($0) }
    }

    AsyncFunction("answerPeer") { (ask: Int, outcome: String, promise: Promise) in
      ControlSocket.shared.answerPeer(ask, outcome) { promise.resolve($0) }
    }

    AsyncFunction("approvals") { (promise: Promise) in
      ControlSocket.shared.approvals { promise.resolve($0) }
    }

    AsyncFunction("revokeApproval") { (key: String, promise: Promise) in
      ControlSocket.shared.revokeApproval(key) { promise.resolve($0) }
    }

    OnDestroy {
      ControlSocket.shared.detach(self)
    }
  }
}
