import ExpoModulesCore

public class ScriptingModule: Module, ScriptingNative {
  private let lifetime = ModuleLifetime()

  static func setScriptState(_ state: [String: Any]) { ShellScripting.setState(state) }

  static func replyToScript(_ id: String, _ result: [String: Any]?, _ error: String?) { ShellScripting.reply(id, result: result, error: error) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.eventsDefinition

    OnCreate { self.lifetime.begin(self) { ShellEvents.retire(self) } }

    OnStartObserving(ShellEvents.Channel.scriptCommand.rawValue) { ShellEvents.attach(.scriptCommand, to: self, while: self.lifetime) }

    OnDestroy {
      self.lifetime.end()
      ShellEvents.detach(self)
    }

    Self.setScriptStateFunction
    Self.replyToScriptFunction
  }
}
