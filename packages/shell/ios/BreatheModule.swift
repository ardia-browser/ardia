import AppKit
import ExpoModulesCore

public class BreatheModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaBreathe")

    View(Breathe.self) {
      Prop("running") { (view: Breathe, running: Bool) in view.running = running }
      Prop("cycleMs") { (view: Breathe, ms: Double) in view.cycleMs = ms }
      Prop("opacityRange") { (view: Breathe, range: [Double]) in view.opacityRange = range }
      Prop("scaleRange") { (view: Breathe, range: [Double]) in view.scaleRange = range }
      OnViewDidUpdateProps { (view: Breathe) in view.propsDidUpdate() }
    }
  }
}
