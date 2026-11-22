import AppKit
import ExpoModulesCore

public class FieldGlowModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaFieldGlow")

    Function("show") { (id: String, timings: [Double]) in
      DispatchQueue.main.async { FieldGlow.hub.show(id, timings: FieldGlowTimings(milliseconds: timings)) }
    }
    Function("progress") { (id: String, to: Double, still: Bool) in
      DispatchQueue.main.async { FieldGlow.hub.progress(id, to: to, still: still) }
    }
    Function("finish") { (id: String, still: Bool) in
      DispatchQueue.main.async { FieldGlow.hub.finish(id, still: still) }
    }
    Function("reset") { (id: String) in
      DispatchQueue.main.async { FieldGlow.hub.reset(id) }
    }

    View(FieldGlow.self) {
      Prop("glowId") { (view: FieldGlow, id: String?) in view.glowId = id }
      Prop("radius") { (view: FieldGlow, v: Double) in view.radius = v }
      Prop("look") { (view: FieldGlow, raw: [String: Any]?) in view.look = Self.look(raw) }
    }
  }

  private static func look(_ raw: [String: Any]?) -> FieldGlowLook {
    guard let raw else { return FieldGlowLook() }
    let number = { (key: String) in (raw[key] as? NSNumber)?.doubleValue ?? 0 }
    let numbers = { (key: String) in (raw[key] as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.doubleValue } }
    let pairs = (raw["glow"] as? [Any] ?? []).map { ($0 as? [Any] ?? []).compactMap { ($0 as? NSNumber)?.doubleValue } }
    return FieldGlowLook(
      rgba: numbers("rgba"), glow: pairs, tailFade: numbers("tailFade"), capFade: numbers("capFade"),
      tail: number("tail"), cap: number("cap"), frontShare: number("frontShare"), tailCeiling: number("tailCeiling"),
      line: number("line"), floor: number("floor")
    )
  }
}
