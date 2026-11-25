import ExpoModulesCore
import Foundation

public class UserScriptsModule: Module, UserScriptsNative {
  static var queue: DispatchQueue { UserScripts.work }

  static func watch(_ on: Bool) { if on { UserScripts.shared.start() } else { UserScripts.shared.stop() } }

  static func read() -> [String: Any] { UserScripts.shared.read() }

  static func readStatus() -> String? { UserScripts.shared.readStatus() }

  static func writeStatus(_ json: String) throws { try UserScripts.shared.writeStatus(json) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.eventsDefinition

    OnCreate {
      UserScripts.shared.emit = { [weak self] in self?.sendEvent("onChange", [:]) }
    }

    Self.watchFunction

    Self.readFunction

    Self.readStatusFunction

    Self.writeStatusFunction
  }
}
