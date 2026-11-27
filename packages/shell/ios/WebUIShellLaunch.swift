import ArdiaCore
import Foundation

public enum WebUIShellLaunch {
  public static func routeIfRequested(_ config: LaunchConfig) {
    #if DEBUG
    if config.webUIRefusedDataDirectory { WebUIShellHost.refuseLiveProfile() }
    guard config.webUIShell, let dataDirectory = config.dataDirectory else { return }
    WebUIShellHost.perform(
      WebUIShellHost.Request(
        dataDirectory: dataDirectory, dataDirectoryDefaulted: config.webUIDataDirectoryDefaulted,
        hostApp: config.webUIHostApp, handedOff: config.webUIHandedOff))
    #endif
  }
}
