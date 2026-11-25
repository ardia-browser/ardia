import AppKit
import ExpoModulesCore

public class FieldGlowModule: Module, FieldGlowNative {
  static func show(_ id: String, _ timings: [Double]) { DispatchQueue.main.async { FieldGlow.hub.show(id, timings: FieldGlowTimings(milliseconds: timings)) } }

  static func progress(_ id: String, _ to: Double, _ still: Bool) { DispatchQueue.main.async { FieldGlow.hub.progress(id, to: to, still: still) } }

  static func pulse(_ id: String, _ period: Double, _ low: Double) {
    DispatchQueue.main.async {
      let pulse = period.isFinite && period > 0 && (0...1).contains(low) ? FieldGlowPulse(period: period / 1000, low: low) : nil
      FieldGlow.hub.pulse(id, pulse)
    }
  }

  static func finish(_ id: String, _ still: Bool) { DispatchQueue.main.async { FieldGlow.hub.finish(id, still: still) } }

  static func reset(_ id: String) { DispatchQueue.main.async { FieldGlow.hub.reset(id) } }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.showFunction
    Self.progressFunction
    Self.pulseFunction
    Self.finishFunction
    Self.resetFunction

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
