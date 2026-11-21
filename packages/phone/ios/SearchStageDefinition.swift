import ArdiaDesign
import ExpoModulesCore
import UIKit

public final class SearchStageModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneSearchStage")

    View(SearchStageView.self) {
      ViewName("SearchStage")
      Events("onLift", "onReveal", "onSettled")
      Prop("shown") { (view: SearchStageView, value: Bool?) in view.shownProp = value ?? false }
      Prop("anchorNativeId") { (view: SearchStageView, value: String?) in view.anchorNativeId = value }
      Prop("faceNativeId") { (view: SearchStageView, value: String?) in view.faceNativeId = value }
      Prop("focusNativeId") { (view: SearchStageView, value: String?) in view.focusNativeId = value }
      Prop("revealNativeId") { (view: SearchStageView, value: String?) in view.revealNativeId = value }
      Prop("rowsRevealNativeId") { (view: SearchStageView, value: String?) in view.rowsRevealNativeId = value }
      Prop("fieldCenter") { (view: SearchStageView, value: Double?) in
        view.fieldCenter = value.map { CGFloat($0) } ?? BrowseLayout.stageFieldCenter(fieldHeight: BrowseLayout.searchFieldHeight)
      }
      Prop("commandTop") { (view: SearchStageView, value: Double?) in view.commandTop = value.map { CGFloat($0) } }
      Prop("landsDirectly") { (view: SearchStageView, value: Bool?) in view.landsDirectly = value ?? false }
      Prop("morphUsesGlass") { (view: SearchStageView, value: Bool?) in view.look.usesGlass = value ?? true }
      Prop("morphPanelTint") { (view: SearchStageView, value: UIColor?) in view.look.panelTint = value ?? .clear }
      Prop("morphPanelDark") { (view: SearchStageView, value: Bool?) in view.look.panelStyle = value == true ? .dark : .unspecified }
      Prop("morphClassicPanel") { (view: SearchStageView, value: UIColor?) in view.look.classicPanel = value ?? .secondarySystemBackground }
      OnViewDidUpdateProps { (view: SearchStageView) in
        MainActor.assumeIsolated { view.propsDidUpdate() }
      }
      AsyncFunction("present") { (view: SearchStageView, promise: Promise) in
        MainActor.assumeIsolated { view.present { promise.resolve(nil) } }
      }.runOnQueue(.main)
      AsyncFunction("holdLift") { (view: SearchStageView) in
        MainActor.assumeIsolated { view.holdLift() }
      }.runOnQueue(.main)
      AsyncFunction("releaseLift") { (view: SearchStageView) in
        MainActor.assumeIsolated { view.releaseLift() }
      }.runOnQueue(.main)
      AsyncFunction("close") { (view: SearchStageView, exit: String, velocity: Double?) in
        MainActor.assumeIsolated { view.close(SearchStageView.Exit(rawValue: exit) ?? .drop, velocity: CGFloat(velocity ?? 0)) }
      }.runOnQueue(.main)
      AsyncFunction("finish") { (view: SearchStageView) in
        MainActor.assumeIsolated { view.finish() }
      }.runOnQueue(.main)
    }

    View(SearchStagePanelView.self) {
      ViewName("SearchStagePanel")
    }
  }
}
