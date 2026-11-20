import Foundation
import WebKit

final class WebKitSiteStorage: NSObject, WKNavigationDelegate {
  private struct Job {
    let origin: URL
    let script: String
    let arguments: [String: Any]
    let done: (Any?) -> Void
  }

  private final class Reader {
    let view: WKWebView
    var queue: [Job] = []
    var running: Job?
    var loadedOrigin: URL?
    var generation = 0
    var idle: DispatchWorkItem?

    init(view: WKWebView) { self.view = view }
  }

  static let maxBytes = 2_000_000
  private static let jobDeadline: TimeInterval = 1.0
  private static let idleClose: TimeInterval = 10
  private static let blankPage = "<!doctype html><meta charset=\"utf-8\"><title></title>"

  private static let readScript = """
    const wellFormed = (text) => {
      if (typeof text.isWellFormed === "function") return text.isWellFormed();
      try { encodeURIComponent(text); return true; } catch { return false; }
    };
    const items = [];
    let size = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const value = localStorage.getItem(key);
      if (key === null || value === null) continue;
      if (!wellFormed(key) || !wellFormed(value)) return null;
      size += key.length + value.length;
      if (size > limit) return null;
      items.push([key, value]);
    }
    return items;
    """

  private static let writeScript = """
    let count = 0;
    for (const [key, value] of set) {
      try { localStorage.setItem(key, value); count++; } catch {}
    }
    for (const key of remove) { localStorage.removeItem(key); count++; }
    return count;
    """

  private var readers: [String: Reader] = [:]

  static func rootURL(_ origin: URL) -> URL? {
    guard let text = WebKitSiteData.origin(of: origin) else { return nil }
    return URL(string: text + "/")
  }

  func read(profile: String, store: WKWebsiteDataStore, origins: [URL], completion: @escaping ([String: Any]) -> Void) {
    let roots = Array(Set(origins.compactMap(Self.rootURL)))
    guard !roots.isEmpty else { return completion([:]) }
    var found: [String: Any] = [:]
    let group = DispatchGroup()
    for root in roots {
      group.enter()
      enqueue(profile: profile, store: store, Job(origin: root, script: Self.readScript, arguments: ["limit": Self.maxBytes]) { value in
        found[WebKitSiteData.origin(of: root) ?? ""] = (value as? [[Any]])?.compactMap { pair -> [String]? in
          guard pair.count == 2, let key = pair[0] as? String, let value = pair[1] as? String else { return nil }
          return [key, value]
        } ?? NSNull()
        group.leave()
      })
    }
    group.notify(queue: .main) { completion(found) }
  }

  func write(profile: String, store: WKWebsiteDataStore, writes: [String: [String: Any]], completion: @escaping (Int) -> Void) {
    var count = 0
    let group = DispatchGroup()
    for (origin, change) in writes {
      guard let url = URL(string: origin), let root = Self.rootURL(url) else { continue }
      let set = (change["set"] as? [[Any]] ?? []).compactMap { pair -> [String]? in
        guard pair.count == 2, let key = pair[0] as? String, let value = pair[1] as? String else { return nil }
        return [key, value]
      }
      let remove = (change["remove"] as? [Any] ?? []).compactMap { $0 as? String }
      guard !set.isEmpty || !remove.isEmpty else { continue }
      group.enter()
      enqueue(profile: profile, store: store, Job(origin: root, script: Self.writeScript, arguments: ["set": set, "remove": remove]) { value in
        count += (value as? NSNumber)?.intValue ?? 0
        group.leave()
      })
    }
    group.notify(queue: .main) { completion(count) }
  }

  func close(profile: String) {
    guard let reader = readers.removeValue(forKey: profile) else { return }
    reader.idle?.cancel()
    reader.view.navigationDelegate = nil
    reader.view.stopLoading()
    let pending = (reader.running.map { [$0] } ?? []) + reader.queue
    for job in pending { job.done(nil) }
  }

  private func reader(profile: String, store: WKWebsiteDataStore) -> Reader {
    if let reader = readers[profile], reader.view.configuration.websiteDataStore === store { return reader }
    close(profile: profile)
    let config = WKWebViewConfiguration()
    config.websiteDataStore = store
    config.mediaTypesRequiringUserActionForPlayback = .all
    let view = WKWebView(frame: .zero, configuration: config)
    view.navigationDelegate = self
    let reader = Reader(view: view)
    readers[profile] = reader
    return reader
  }

  private func enqueue(profile: String, store: WKWebsiteDataStore, _ job: Job) {
    let reader = reader(profile: profile, store: store)
    reader.idle?.cancel()
    reader.queue.append(job)
    runNext(profile)
  }

  private func runNext(_ profile: String) {
    guard let reader = readers[profile], reader.running == nil else { return }
    guard !reader.queue.isEmpty else { return scheduleClose(profile, reader) }
    let job = reader.queue.removeFirst()
    reader.running = job
    reader.generation += 1
    let generation = reader.generation
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.jobDeadline) { [weak self] in
      guard let self, let reader = self.readers[profile], reader.generation == generation, reader.running != nil else { return }
      self.close(profile: profile)
    }
    if reader.loadedOrigin == job.origin, reader.view.url == job.origin { return evaluate(profile, reader, job, generation) }
    reader.loadedOrigin = nil
    reader.view.loadSimulatedRequest(URLRequest(url: job.origin), responseHTML: Self.blankPage)
  }

  private func evaluate(_ profile: String, _ reader: Reader, _ job: Job, _ generation: Int) {
    reader.view.callAsyncJavaScript(job.script, arguments: job.arguments, in: nil, in: .page) { [weak self] result in
      guard let self, self.readers[profile] === reader, reader.generation == generation, reader.running != nil else { return }
      reader.running = nil
      job.done(try? result.get())
      self.runNext(profile)
    }
  }

  private func scheduleClose(_ profile: String, _ reader: Reader) {
    let item = DispatchWorkItem { [weak self, weak reader] in
      guard let self, let reader, self.readers[profile] === reader, reader.running == nil, reader.queue.isEmpty else { return }
      self.close(profile: profile)
    }
    reader.idle = item
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.idleClose, execute: item)
  }

  private func owner(of view: WKWebView) -> (profile: String, reader: Reader)? {
    readers.first { $0.value.view === view }.map { (profile: $0.key, reader: $0.value) }
  }

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences,
               decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void) {
    let expected = owner(of: webView)?.reader.running?.origin
    let allowed = action.targetFrame?.isMainFrame == true && expected != nil && action.request.url == expected
    decisionHandler(allowed ? .allow : .cancel, preferences)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    guard let found = owner(of: webView) else { return }
    let (profile, reader) = found
    guard let job = reader.running, webView.url == job.origin else { return }
    reader.loadedOrigin = job.origin
    evaluate(profile, reader, job, reader.generation)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failRunning(webView) }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failRunning(webView) }

  private func failRunning(_ webView: WKWebView) {
    guard let found = owner(of: webView) else { return }
    let (profile, reader) = found
    guard let job = reader.running else { return }
    reader.running = nil
    reader.loadedOrigin = nil
    job.done(nil)
    runNext(profile)
  }
}
