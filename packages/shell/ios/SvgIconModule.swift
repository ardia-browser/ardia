import AppKit
import ArdiaCore
import ExpoModulesCore

public class SvgIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaSvgIcon")

    View(SvgIconView.self) {
      Prop("svg") { (view: SvgIconView, svg: String) in view.svg = svg }
      Prop("color") { (view: SvgIconView, hex: String?) in view.tint = hex.flatMap { RGBA(hex: $0)?.srgb } }
    }
  }
}
