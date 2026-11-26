import ArdiaDesign
import ArdiaSync
import ExpoModulesCore
import os
import PhoneSync
import SwiftUI
import UIKit
import UniformTypeIdentifiers

public final class SyncModule: Module {
  private let alive = OSAllocatedUnfairLock(initialState: true)

  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneSync")

    Events("onSyncEvent")

    OnCreate {
      onMain { [weak self] in
        guard let self else { return }
        let host = PhoneSyncHost.shared
        host.listen(self) { [weak self] change in self?.emit(change) }
        Task { @MainActor in await host.useDemoIfAsked() }
      }
    }

    OnDestroy {
      alive.withLock { $0 = false }
      onMain { [weak self] in
        guard let self else { return }
        PhoneSyncHost.shared.stopListening(self)
        FolderPicker.shared.cancel()
        FolderPicks.shared.forgetAll()
      }
    }

    AsyncFunction("status") { (promise: Promise) in
      PageViewModule.main(promise) { SyncPayloads.object(await Self.status()) }
    }

    AsyncFunction("view") { (promise: Promise) in
      PageViewModule.main(promise) { SyncPayloads.object(SyncPayloads.view(await PhoneSyncHost.shared.ready())) }
    }

    AsyncFunction("isCycleRunning") { (promise: Promise) in
      PageViewModule.main(promise) { await PhoneSyncHost.shared.ready().isCycleRunning }
    }

    AsyncFunction("incoming") { (promise: Promise) in
      PageViewModule.main(promise) { PhoneSyncHost.shared.incoming.map(SyncPayloads.received) }
    }

    Function("check") { (phrase: String) -> [String: Any] in
      SyncPayloads.object(SyncPayloads.check(SyncService.check(phrase: phrase)))
    }

    AsyncFunction("connect") { (phrase: String, promise: Promise) in
      PageViewModule.main(promise) { () -> [String: Any] in
        let host = PhoneSyncHost.shared
        let sync = await host.ready()
        guard let folder = await FolderPicker.shared.pick() else { return SyncPayloads.object(SyncPayloads.connect(nil)) }
        return SyncPayloads.object(SyncPayloads.connect(await sync.connect(phrase: phrase, folder: folder)))
      }
    }

    AsyncFunction("pickFolder") { (promise: Promise) in
      PageViewModule.main(promise) { () -> [String: Any]? in
        guard let url = await FolderPicker.shared.pick() else { return nil }
        return FolderPicks.shared.hold(url)
      }
    }

    AsyncFunction("connectWithFolder") { (phrase: String, folder: String, promise: Promise) in
      PageViewModule.main(promise) { () -> [String: Any] in
        let sync = await PhoneSyncHost.shared.ready()
        guard let url = FolderPicks.shared.url(folder) else { return SyncPayloads.object(SyncPayloads.connect(.folderUnavailable)) }
        let result = await sync.connect(phrase: phrase, folder: url)
        if result == .connected { FolderPicks.shared.forget(folder) }
        return SyncPayloads.object(SyncPayloads.connect(result))
      }
    }

    AsyncFunction("forgetFolder") { (folder: String, promise: Promise) in
      PageViewModule.main(promise) { FolderPicks.shared.forget(folder) }
    }

    AsyncFunction("changeFolder") { (promise: Promise) in
      PageViewModule.main(promise) { () -> [String: Any] in
        let sync = await PhoneSyncHost.shared.ready()
        guard let folder = await FolderPicker.shared.pick() else { return SyncPayloads.object(SyncPayloads.connect(nil)) }
        return SyncPayloads.object(SyncPayloads.connect(await sync.changeFolder(folder)))
      }
    }

    AsyncFunction("stopSyncing") { (promise: Promise) in
      PageViewModule.main(promise) { await PhoneSyncHost.shared.stopSyncing() }
    }

    AsyncFunction("acknowledgeReset") { (promise: Promise) in
      PageViewModule.main(promise) { await PhoneSyncHost.shared.ready().acknowledgeReset() }
    }

    AsyncFunction("syncNow") { (promise: Promise) in
      PageViewModule.main(promise) { await PhoneSyncHost.shared.ready().syncNow() }
    }

    AsyncFunction("setDeviceName") { (name: String, promise: Promise) in
      PageViewModule.main(promise) {
        let sync = await PhoneSyncHost.shared.ready()
        sync.deviceName = name
      }
    }

    AsyncFunction("selectProfile") { (profileSyncId: String?, promise: Promise) in
      PageViewModule.main(promise) {
        let sync = await PhoneSyncHost.shared.ready()
        sync.selectedProfileId = profileSyncId
      }
    }

    AsyncFunction("receivers") { (profileSyncId: String?, promise: Promise) in
      PageViewModule.main(promise) { SyncPayloads.list(await PhoneSyncHost.shared.ready().devicesThatReceiveTabs(in: profileSyncId).map(SyncPayloads.device)) }
    }

    AsyncFunction("send") { (url: String, title: String, deviceId: String, profileSyncId: String?, fromPrivateTab: Bool, promise: Promise) in
      PageViewModule.main(promise) { () -> Bool in
        guard !fromPrivateTab, PhoneBrowsingSource.isSyncable(url), let page = URL(string: url) else { return false }
        let sync = await PhoneSyncHost.shared.ready()
        guard let target = sync.snapshot.devices.first(where: { $0.id == deviceId }) else { return false }
        return await sync.send(url: page, title: title, to: target, profileSyncId: profileSyncId)
      }
    }

    AsyncFunction("pinToMac") { (url: String, title: String, profileSyncId: String?, fromPrivateTab: Bool, promise: Promise) in
      PageViewModule.main(promise) { () -> Bool in
        guard !fromPrivateTab, PhoneBrowsingSource.isSyncable(url), let page = URL(string: url) else { return false }
        let outcome = await PhoneSyncHost.shared.ready().addBookmark(url: page, title: title, profileSyncId: profileSyncId)
        return outcome != .failed
      }
    }

    AsyncFunction("answerVaultRequest") { (id: String, allow: Bool, always: Bool, promise: Promise) in
      PageViewModule.main(promise) { await PhoneSyncHost.shared.ready().answerVault(id: id, allow: allow, always: always).rawValue }
    }

    AsyncFunction("prepareVaultKey") { (promise: Promise) in
      PageViewModule.main(promise) { await PhoneSyncHost.shared.ready().prepareVaultKey() }
    }

    AsyncFunction("clearIncoming") {
      MainActor.assumeIsolated { PhoneSyncHost.shared.clearIncoming() }
    }.runOnQueue(.main)

    Function("localDidChange") {
      DispatchQueue.main.async {
        MainActor.assumeIsolated { PhoneSyncHost.shared.service.localDidChange() }
      }
    }

    AsyncFunction("inbox") { () -> [[String: Any]] in
      MainActor.assumeIsolated { SyncPayloads.inbox(PhoneSyncHost.shared.inbox.entries()) }
    }.runOnQueue(.main)

    AsyncFunction("inboxApplied") { (ids: [Double]) in
      try MainActor.assumeIsolated { try PhoneSyncHost.shared.inbox.applied(Set(ids.map { Int64($0) })) }
    }.runOnQueue(.main)
  }

  @MainActor
  static func status() async -> [String: Any?] {
    let host = PhoneSyncHost.shared
    let sync = await host.ready()
    return SyncPayloads.status(sync, isDemo: host.isDemo, inboxProblem: host.inbox.problem)
  }

  @MainActor
  private func emit(_ change: PhoneSyncHost.Change) {
    guard alive.withLock({ $0 }) else { return }
    let host = PhoneSyncHost.shared
    switch change {
    case .status:
      sendEvent("onSyncEvent", ["name": "sync.status", "status": SyncPayloads.object(SyncPayloads.status(host.service, isDemo: host.isDemo, inboxProblem: host.inbox.problem))])
    case .view:
      sendEvent("onSyncEvent", ["name": "sync.view", "view": SyncPayloads.object(SyncPayloads.view(host.service))])
    case .incoming:
      sendEvent("onSyncEvent", ["name": "sync.incoming", "tabs": host.incoming.map(SyncPayloads.received)])
    case .inbox(let count):
      sendEvent("onSyncEvent", ["name": "sync.inbox", "count": count])
    }
  }
}

@MainActor
final class FolderPicks {
  static let shared = FolderPicks()

  private struct Pick {
    var url: URL
    let bookmark: Data?
    var accessing: Bool
  }

  private var picks: [String: Pick] = [:]

  func hold(_ url: URL) -> [String: Any] {
    let accessing = url.startAccessingSecurityScopedResource()
    let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    let id = UUID().uuidString
    picks[id] = Pick(url: url, bookmark: bookmark, accessing: accessing)
    return ["folder": id, "name": url.lastPathComponent]
  }

  func url(_ id: String) -> URL? {
    guard var pick = picks[id] else { return nil }
    if FileManager.default.isReadableFile(atPath: pick.url.path(percentEncoded: false)) { return pick.url }
    guard let bookmark = pick.bookmark else { return pick.url }
    var stale = false
    guard let resolved = try? URL(resolvingBookmarkData: bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else { return pick.url }
    if pick.accessing { pick.url.stopAccessingSecurityScopedResource() }
    pick.accessing = resolved.startAccessingSecurityScopedResource()
    pick.url = resolved
    picks[id] = pick
    return resolved
  }

  func forget(_ id: String) {
    guard let pick = picks.removeValue(forKey: id) else { return }
    if pick.accessing { pick.url.stopAccessingSecurityScopedResource() }
  }

  func forgetAll() {
    for id in Array(picks.keys) { forget(id) }
  }
}

@MainActor
final class FolderPicker {
  static let shared = FolderPicker()

  private var waiting: CheckedContinuation<URL?, Never>?
  private weak var host: UIViewController?

  func pick() async -> URL? {
    guard waiting == nil, let presenter = Self.presenter() else { return nil }
    return await withCheckedContinuation { continuation in
      waiting = continuation
      let host = UIHostingController(rootView: FolderPickerHost { [weak self] url in self?.finish(url) })
      host.view.backgroundColor = .clear
      host.modalPresentationStyle = .overFullScreen
      self.host = host
      presenter.present(host, animated: false)
    }
  }

  func cancel() {
    finish(nil)
  }

  private func finish(_ url: URL?) {
    let continuation = waiting
    waiting = nil
    if let host, host.presentingViewController != nil { host.dismiss(animated: false) }
    host = nil
    continuation?.resume(returning: url)
  }

  private static func presenter() -> UIViewController? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    var top = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

private struct FolderPickerHost: View {
  let done: (URL?) -> Void
  @State private var isPresented = false

  var body: some View {
    Color.clear
      .ignoresSafeArea()
      .folderPicker(isPresented: $isPresented) { url in done(url) }
      .onAppear { isPresented = true }
      .onChange(of: isPresented) { _, showing in
        guard !showing else { return }
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(300))
          done(nil)
        }
      }
  }
}
