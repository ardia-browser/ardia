import AppKit
import ArdiaCore
import MachO
import ExpoModulesCore

public class AppModule: Module, AppNative {
  static var apiVersion: Int { 99 }

  static func interfaceScale() -> Double { Double(InterfaceScale.scale) }

  static func interfaceScaleRange() -> [Double] { [Double(InterfaceScale.minimum), Double(InterfaceScale.maximum)] }

  static func setInterfaceScale(_ scale: Double) -> Double {
    InterfaceScale.scale = CGFloat(scale)
    return Double(InterfaceScale.scale)
  }

  static func setWindowActivity(_ windowId: String, _ url: String?, _ title: String?) { Handoff.setActivity(windowId: windowId, url: url, title: title) }

  static func share(_ url: String, _ title: String?, _ windowId: String?, _ anchor: [Double]?, _ promise: Promise) { SharePicker.show(url: url, title: title, windowId: windowId, anchor: anchor) { promise.resolve(nil) } }

  static func shareText(_ text: String, _ windowId: String?, _ anchor: [Double]?, _ promise: Promise) { SharePicker.show(text: text, windowId: windowId, anchor: anchor) { promise.resolve(nil) } }

  static func shareVia(_ service: String, _ url: String, _ title: String?, _ windowId: String?) { SharePicker.perform(service: service, url: url, title: title, windowId: windowId) }

  static func isInDock() -> Bool { DockTile.isInDock }

  static func addToDock() -> Bool { DockTile.add() }

  static func appIcons(_ size: Double) -> [[String: Any]] { AppIcons.variants.map { ["id": $0.id, "name": $0.name, "flat": $0.flat, "preview": AppIcons.preview($0.id, size: size) as Any] } }

  static func appIcon() -> String { AppIcons.current }

  static func setAppIcon(_ id: String) { AppIcons.set(id, announce: !LaunchConfig.shared.isolated) }

  static func systemInfo() -> [String: Any] {
    let info = Bundle.main.infoDictionary ?? [:]
    let config = LaunchConfig.shared
    let os = ProcessInfo.processInfo.operatingSystemVersion
    var model = [CChar](repeating: 0, count: 256)
    var size = model.count
    sysctlbyname("hw.model", &model, &size, nil, 0)
    #if DEBUG
    let configuration = "Debug"
    #else
    let configuration = "Release"
    #endif
    return [
      "appName": info["CFBundleName"] as? String ?? "Ardia",
      "appVersion": info["CFBundleShortVersionString"] as? String ?? "",
      "appBuild": info["CFBundleVersion"] as? String ?? "",
      "bundleId": Bundle.main.bundleIdentifier ?? "",
      "configuration": configuration,
      "osVersion": "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)",
      "osBuild": Self.osBuild,
      "arch": Self.arch,
      "model": String(cString: model),
      "memoryGB": Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824,
      "locale": Locale.current.identifier,
      "feedbackURL": Self.infoString("ACFeedbackURL") as Any,
      "feedbackEmail": Self.infoString("ACFeedbackEmail") as Any,
      "videoTourURL": Self.infoString("ACVideoTourURL") as Any,
      "releaseNotesURL": Self.infoString("ACReleaseNotesURL") as Any,
      "engineMatch": Self.infoString("ArdiaEngineMatch") as Any,
      "isolatedInstance": config.isolated,
      "forceReleaseNotes": config.instanceFlag("releaseNotes"),
      "processStart": Self.processStart as Any,
      "bootTime": Self.bootTime as Any,
      "launchMarks": ArdiaHost.launchMarks,
      "launchUsage": ArdiaHost.launchUsage,
      "launchedHidden": ArdiaHost.launchedHidden as Any,
      "launchSource": ArdiaHost.launchSource as Any,
      "loadAverage1m": Self.loadAverage1m as Any,
      "inApplicationsFolder": Self.inApplicationsFolder,
      "updatePrewarm": UserDefaults.standard.dictionary(forKey: UpdatePrewarm.lastRunKey) as Any,
    ]
  }

  static func crashReports(_ since: Double) -> [[String: Any]] { CrashReports.since(since) }

  static func hardwareInfo() -> [String: Any] { DiagnosticsInfo.hardware() }

  static func diagnosticsSample() -> [String: Any] { DiagnosticsInfo.sample() }

  static func openExternalURL(_ url: String) -> Bool {
    guard let target = URL(string: url), target.scheme != nil else { return false }
    return NSWorkspace.shared.open(target)
  }

  static func playIntroMusic(_ cues: [String: Double], _ muted: Bool) { IntroMusic.shared.play(cues: cues, muted: muted) }

  static func setIntroMusicMuted(_ muted: Bool) { IntroMusic.shared.setMuted(muted) }

  static func stopIntroMusic(_ fade: Double) { IntroMusic.shared.stop(fade: fade) }

  static func launchConfig() -> [String: Any] { LaunchConfig.shared.snapshot }

  public func definition() -> ModuleDefinition {
    Name(Self.moduleName)
    Self.apiVersionConstant

    OnCreate {
      DispatchQueue.main.async { AppIcons.restore() }
    }

    Self.interfaceScaleFunction
    Self.interfaceScaleRangeFunction
    Self.setInterfaceScaleFunction

    Self.setWindowActivityFunction

    Self.shareFunction

    Self.shareTextFunction

    Self.shareViaFunction

    Self.isInDockFunction
    Self.addToDockFunction

    Self.appIconsFunction
    Self.appIconFunction
    Self.setAppIconFunction

    Self.systemInfoFunction

    Self.crashReportsFunction
    Self.hardwareInfoFunction
    Self.diagnosticsSampleFunction

    Self.openExternalURLFunction

    Self.playIntroMusicFunction
    Self.setIntroMusicMutedFunction
    Self.stopIntroMusicFunction
    Self.launchConfigFunction
  }

  private static func infoString(_ key: String) -> String? {
    let value = (Bundle.main.object(forInfoDictionaryKey: key) as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
    return value?.isEmpty == false ? value : nil
  }

  private static var osBuild: String {
    var size = 0
    sysctlbyname("kern.osversion", nil, &size, nil, 0)
    var build = [CChar](repeating: 0, count: max(size, 1))
    sysctlbyname("kern.osversion", &build, &size, nil, 0)
    return String(cString: build)
  }

  private static var arch: String {
    #if arch(arm64)
    "arm64"
    #else
    "x86_64"
    #endif
  }

  private static var inApplicationsFolder: Bool {
    let path = Bundle.main.bundleURL.resolvingSymlinksInPath().path
    let home = FileManager.default.homeDirectoryForCurrentUser.resolvingSymlinksInPath().path
    return path.hasPrefix("/Applications/") || path.hasPrefix(home + "/Applications/")
  }
}

extension AppModule {
  fileprivate static let bootTime: Double? = {
    var boot = timeval()
    var size = MemoryLayout<timeval>.stride
    var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
    guard sysctl(&mib, 2, &boot, &size, nil, 0) == 0 else { return nil }
    return Double(boot.tv_sec) * 1000 + Double(boot.tv_usec) / 1000
  }()

  fileprivate static var loadAverage1m: Double? {
    var loads = [Double](repeating: 0, count: 1)
    return getloadavg(&loads, 1) == 1 ? loads[0] : nil
  }

  fileprivate static let processStart: Double? = {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
    let start = info.kp_proc.p_starttime
    return Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
  }()
}
