import AppKit
import ArdiaCore
import ExpoModulesCore

public class FolderIconModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaFolderIcon")

    View(FolderIconView.self) {
      Prop("open") { (view: FolderIconView, open: Bool) in view.wantsOpen = open }
      Prop("stroke") { (view: FolderIconView, hex: String) in view.palette.stroke = RGBA(hex: hex)?.srgb ?? view.palette.stroke }
      Prop("face") { (view: FolderIconView, hex: String) in view.palette.face = RGBA(hex: hex)?.srgb ?? view.palette.face }
      Prop("insideTop") { (view: FolderIconView, hex: String) in view.palette.insideTop = RGBA(hex: hex)?.srgb ?? view.palette.insideTop }
      Prop("insideBottom") { (view: FolderIconView, hex: String) in view.palette.insideBottom = RGBA(hex: hex)?.srgb ?? view.palette.insideBottom }
      OnViewDidUpdateProps { (view: FolderIconView) in view.propsDidUpdate() }
    }
  }
}
