import ExpoModulesCore
import ExpoUI
import SwiftUI

final class BrowseForMeSettingsProps: UIBaseViewProps {}

struct BrowseForMeSettingsView: ExpoSwiftUI.View {
  @ObservedObject var props: BrowseForMeSettingsProps

  var body: some View {
    BrowseForMePage()
  }
}

public final class BrowseForMeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneBrowseForMe")

    Events("onBrowseForMe")

    OnCreate {
      onMain {
        BrowseForMeHost.shared.sink = { [weak self] event in self?.sendEvent("onBrowseForMe", event) }
      }
    }

    OnDestroy {
      onMain { BrowseForMeHost.shared.sink = nil }
    }

    AsyncFunction("isConnected") { () -> Bool in
      MainActor.assumeIsolated { BrowseForMeHost.shared.isConnected }
    }.runOnQueue(.main)

    AsyncFunction("open") { (query: String) in
      MainActor.assumeIsolated { BrowseForMeHost.shared.open(query) }
    }.runOnQueue(.main)

    ExpoUIView(BrowseForMeSettingsView.self)
  }
}
