import AppKit
import Carbon.HIToolbox
import ExpoModulesCore

public class VisualEffectModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaVisualEffect")

    View(VisualEffect.self) {
      Prop("material") { (view: VisualEffect, name: String) in view.setMaterial(name) }
      Prop("blendingMode") { (view: VisualEffect, name: String) in
        view.effect.blendingMode = name == "behindWindow" ? .behindWindow : .withinWindow
      }
      Prop("cornerRadius") { (view: VisualEffect, v: Double) in view.cornerRadius = v }
    }
  }
}

public class ProgressiveBlurModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaProgressiveBlur")

    View(ProgressiveBlur.self) {
      Prop("radius") { (view: ProgressiveBlur, v: Double) in view.radius = v }
      Prop("solidShare") { (view: ProgressiveBlur, v: Double) in view.solidShare = v }
    }
  }
}

public class EdgeFadeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaEdgeFade")

    View(EdgeFade.self) {
      Prop("fadeHeight") { (view: EdgeFade, v: Double) in view.fadeHeight = v }
      Prop("active") { (view: EdgeFade, v: Bool) in view.active = v }
    }
  }
}
