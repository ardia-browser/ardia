import AppKit

extension VaultDeliveredCodes {
  static let fullDiskAccessPane = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"

  static let shared = VaultDeliveredCodes(
    paths: .live(messagesFixture: LaunchConfig.shared.testValue("deliveredMessages"), mailFixture: LaunchConfig.shared.testValue("deliveredMail")),
    hooks: VaultDeliveredHooks(
      announce: { state in
        let data = ArdiaConsentStamp.begin().onto(state.jsonObject())
        DispatchQueue.main.async { ArdiaEvents.emit("vaults.deliveredCodesChanged", data: data) }
      }))

  static func openFullDiskAccess() async -> [String: Any] {
    guard let pane = URL(string: fullDiskAccessPane) else { return ["opened": false] }
    let opened = await MainActor.run { NSWorkspace.shared.open(pane) }
    await shared.watchForAccess()
    return ["opened": opened]
  }
}
