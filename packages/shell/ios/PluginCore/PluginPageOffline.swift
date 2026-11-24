import Foundation

enum PluginPageOffline {
  static let setPeers = NSSelectorFromString("_setPeerConnectionEnabled:")
  static let peers = NSSelectorFromString("_peerConnectionEnabled")
  static let setHosts = NSSelectorFromString("_setAllowedNetworkHosts:")
  static let hosts = NSSelectorFromString("_allowedNetworkHosts")

  private typealias SetFlag = @convention(c) (AnyObject, Selector, ObjCBool) -> Void
  private typealias GetFlag = @convention(c) (AnyObject, Selector) -> ObjCBool

  static func hold(preferences: NSObject, configuration: NSObject) -> Bool {
    guard preferences.responds(to: setPeers), preferences.responds(to: peers), configuration.responds(to: setHosts), configuration.responds(to: hosts) else { return false }
    unsafeBitCast(preferences.method(for: setPeers), to: SetFlag.self)(preferences, setPeers, ObjCBool(false))
    configuration.perform(setHosts, with: NSSet())
    return isHeld(preferences: preferences, configuration: configuration)
  }

  static func isHeld(preferences: NSObject, configuration: NSObject) -> Bool {
    guard preferences.responds(to: peers), configuration.responds(to: hosts) else { return false }
    let peersOn = unsafeBitCast(preferences.method(for: peers), to: GetFlag.self)(preferences, peers).boolValue
    guard let allowed = configuration.perform(hosts)?.takeUnretainedValue() as? NSSet else { return false }
    return !peersOn && allowed.count == 0
  }
}
