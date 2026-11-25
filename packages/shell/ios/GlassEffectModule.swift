import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

public class GlassEffectModule: Module, GlassEffectNative {
  static func isLiquidGlass() -> Bool { LiquidGlass.available }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    Self.isLiquidGlassFunction

    View(GlassEffect.self) {
      Prop("cornerRadius") { (view: GlassEffect, v: Double) in view.cornerRadius = v }
      Prop("tint") { (view: GlassEffect, hex: String?) in view.tint = hex.flatMap { RGBA(hex: $0)?.srgb } }
      Prop("glassStyle") { (view: GlassEffect, style: String?) in view.clear = style == "clear" }
      Prop("dark") { (view: GlassEffect, dark: Bool?) in view.appearance = dark.map { NSAppearance(named: $0 ? .darkAqua : .aqua) } ?? nil }
    }
  }
}
