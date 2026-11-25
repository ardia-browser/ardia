import ExpoModulesCore
import Foundation

public class ConfigModule: Module, ConfigNative {
  static func readFile(_ name: String) -> [String: Any] { ConfigFolder.read(name) }

  func watch(_ names: [String], _ promise: Promise) { ConfigWatcher.shared.watch(names, armed: { promise.resolve(nil) }) { [weak self] in self?.sendEvent("onChange", [:]) } }

  static func writeSchemas(_ files: [String: String]) throws -> [String] { try ConfigFolder.writeSchemas(files) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.eventsDefinition

    Self.readFileFunction

    watchFunction

    Self.writeSchemasFunction

    OnDestroy { ConfigWatcher.shared.stop() }
  }
}
