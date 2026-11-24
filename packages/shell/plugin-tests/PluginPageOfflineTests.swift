import WebKit
import XCTest

@testable import ArdiaPluginCore

final class PluginPageOfflineTests: XCTestCase {
  private final class IgnoringPreferences: NSObject {
    @objc(_setPeerConnectionEnabled:) func setPeers(_ on: ObjCBool) {}
    @objc(_peerConnectionEnabled) func peers() -> ObjCBool { ObjCBool(true) }
  }

  private final class TakingPreferences: NSObject {
    var on = true
    @objc(_setPeerConnectionEnabled:) func setPeers(_ on: ObjCBool) { self.on = on.boolValue }
    @objc(_peerConnectionEnabled) func peers() -> ObjCBool { ObjCBool(on) }
  }

  private final class IgnoringConfiguration: NSObject {
    @objc(_setAllowedNetworkHosts:) func setHosts(_ hosts: NSSet?) {}
    @objc(_allowedNetworkHosts) func hosts() -> NSSet? { nil }
  }

  private final class TakingConfiguration: NSObject {
    var allowed: NSSet?
    @objc(_setAllowedNetworkHosts:) func setHosts(_ hosts: NSSet?) { allowed = hosts }
    @objc(_allowedNetworkHosts) func hosts() -> NSSet? { allowed }
  }

  func testThisMacOSHoldsAPageOfflineAndTheWebViewKeepsIt() {
    let configuration = WKWebViewConfiguration()
    XCTAssertTrue(PluginPageOffline.hold(preferences: configuration.preferences, configuration: configuration))
    let view = WKWebView(frame: .zero, configuration: configuration)
    XCTAssertTrue(PluginPageOffline.isHeld(preferences: view.configuration.preferences, configuration: view.configuration), "the web view's own copy keeps both settings")
  }

  func testAFreshConfigurationIsNotHeld() {
    let configuration = WKWebViewConfiguration()
    XCTAssertFalse(PluginPageOffline.isHeld(preferences: configuration.preferences, configuration: configuration))
  }

  func testASetterThatSilentlyDoesNothingIsRefused() {
    XCTAssertFalse(PluginPageOffline.hold(preferences: IgnoringPreferences(), configuration: TakingConfiguration()), "peer connections stayed on")
    XCTAssertFalse(PluginPageOffline.hold(preferences: TakingPreferences(), configuration: IgnoringConfiguration()), "network hosts weren't restricted")
    XCTAssertTrue(PluginPageOffline.hold(preferences: TakingPreferences(), configuration: TakingConfiguration()))
  }

  func testMissingSwitchesAreRefused() {
    XCTAssertFalse(PluginPageOffline.hold(preferences: NSObject(), configuration: TakingConfiguration()))
    XCTAssertFalse(PluginPageOffline.hold(preferences: TakingPreferences(), configuration: NSObject()))
  }
}
