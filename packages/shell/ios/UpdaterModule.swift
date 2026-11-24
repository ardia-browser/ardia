import ExpoModulesCore

public class UpdaterModule: Module, UpdaterNative {
  static func updaterState() -> [String: Any] { AppUpdater.shared.state }

  static func checkForUpdates() { AppUpdater.shared.checkForUpdates(nil) }

  static func setAutomaticUpdateChecks(_ on: Bool) { AppUpdater.shared.setAutomaticChecks(on) }

  static func setAutomaticUpdateDownloads(_ on: Bool) { AppUpdater.shared.setAutomaticDownloads(on) }

  static func setUpdateChannel(_ channel: UpdateChannel) { AppUpdater.shared.setChannel(channel) }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)

    OnCreate {
      DispatchQueue.main.async { AppUpdater.shared.start() }
    }

    Self.updaterStateFunction
    Self.checkForUpdatesFunction
    Self.setAutomaticUpdateChecksFunction
    Self.setAutomaticUpdateDownloadsFunction
    Self.setUpdateChannelFunction
  }
}
