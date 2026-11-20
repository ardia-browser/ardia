import AppKit
import ArdiaCore
import Carbon.HIToolbox
import ExpoModulesCore

public class SymbolModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaSymbol")

    View(SymbolView.self) {
      Prop("name") { (view: SymbolView, name: String) in view.name = name }
      Prop("size") { (view: SymbolView, size: Double) in view.pointSize = size }
      Prop("weight") { (view: SymbolView, weight: String) in view.weight = weight }
      Prop("bounce") { (view: SymbolView, count: Int) in view.bounce = count }
      Prop("replace") { (view: SymbolView, replace: Bool) in view.replace = replace }
      Prop("color") { (view: SymbolView, hex: String) in view.tint = RGBA(hex: hex)?.srgb }
    }
  }
}
