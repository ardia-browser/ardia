import AppKit

final class FolderMediaWatches {
  static let shared = FolderMediaWatches()

  private static let settle = 0.25
  private static let longestWait = 1.0

  private struct Pending {
    let since: DispatchTime
    let work: DispatchWorkItem
  }

  private let queue = DispatchQueue(label: "ardia.folder-media-watch", qos: .utility)
  private var watches: [String: FolderWatch] = [:]
  private var registered: Set<String> = []
  private var pending: [String: Pending] = [:]
  private var volumeObservers: [NSObjectProtocol] = []

  func watch(token: String, folder: String, onChange: @escaping (String) -> Void) {
    queue.async {
      self.end(token)
      let watch = FolderWatch(path: folder, queue: self.queue, waitsForAbsentFolder: true) { [weak self] in self?.changed(token, onChange: onChange) }
      self.watches[token] = watch
      watch.start()
      self.observeVolumes()
    }
  }

  func stop(token: String) {
    queue.async { self.end(token) }
  }

  func stopAll() {
    queue.async {
      for token in Array(self.watches.keys) { self.end(token) }
    }
  }

  private func observeVolumes() {
    guard volumeObservers.isEmpty else { return }
    let center = NSWorkspace.shared.notificationCenter
    volumeObservers = [NSWorkspace.didMountNotification, NSWorkspace.didRenameVolumeNotification].map { name in
      center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in self?.retryAll() }
    }
  }

  private func forgetVolumes() {
    guard watches.isEmpty else { return }
    volumeObservers.forEach(NSWorkspace.shared.notificationCenter.removeObserver)
    volumeObservers = []
  }

  private func retryAll() {
    queue.async {
      for watch in self.watches.values { watch.retry() }
    }
  }

  private func changed(_ token: String, onChange: @escaping (String) -> Void) {
    guard watches[token] != nil else { return }
    guard registered.contains(token) else {
      registered.insert(token)
      return
    }
    let work = DispatchWorkItem { [weak self] in
      guard let self, self.watches[token] != nil else { return }
      self.pending[token] = nil
      onChange(token)
    }
    let now = DispatchTime.now()
    let earlier = pending.removeValue(forKey: token)
    earlier?.work.cancel()
    let since = earlier?.since ?? now
    let waited = Double(now.uptimeNanoseconds - since.uptimeNanoseconds) / 1_000_000_000
    pending[token] = Pending(since: since, work: work)
    queue.asyncAfter(deadline: now + max(0, min(Self.settle, Self.longestWait - waited)), execute: work)
  }

  private func end(_ token: String) {
    pending.removeValue(forKey: token)?.work.cancel()
    registered.remove(token)
    watches.removeValue(forKey: token)?.stop()
    forgetVolumes()
  }
}
