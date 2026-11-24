import AppKit
import ExpoModulesCore

public class WindowProfileModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaWindowProfile")

    View(WindowProfileView.self) {
      Events("onSwapped")
      Prop("profile") { (view: WindowProfileView, value: String?) in view.profile = value ?? "" }
      Prop("neighbours") { (view: WindowProfileView, value: [String]?) in view.neighbours = value ?? [] }
      Prop("selection") { (view: WindowProfileView, value: String?) in view.selection = value ?? "" }
      Prop("switchId") { (view: WindowProfileView, value: Int?) in view.switchId = value ?? 0 }
      OnViewDidUpdateProps { view in view.scheduleSwap() }
    }
  }
}
