import ExpoModulesCore

public class MeadowModule: Module, MeadowNative {
  static func debugState() -> [String: Any] { MeadowView.debugState }

  static func debugEval(_ script: String, _ promise: Promise) {
    guard let view = MeadowView.live else { return promise.resolve(nil) }
    view.evaluate(script) { promise.resolve($0) }
  }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.debugStateFunction
    Self.debugEvalFunction

    View(MeadowView.self) {
      Prop("night") { (view: MeadowView, night: Bool) in view.night = night }
      Events("onTone")
    }
  }
}
