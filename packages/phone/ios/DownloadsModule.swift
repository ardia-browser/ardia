import ArdiaBrowser
import ExpoModulesCore
import QuickLook
import UIKit
import UniformTypeIdentifiers

@MainActor
enum DownloadedFiles {
  static var directory: URL { PhonePages.shared.engine.downloads.directory }

  static func list() -> [[String: Any]] {
    let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
    let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles])) ?? []
    return urls.compactMap { url -> (URL, Int, Date)? in
      guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { return nil }
      return (url, values.fileSize ?? 0, values.contentModificationDate ?? .distantPast)
    }
    .sorted { $0.2 > $1.2 }
    .map { url, size, modified in
      ["name": url.lastPathComponent, "uri": url.absoluteString, "size": size, "modified": modified.timeIntervalSince1970 * 1000, "kind": kind(of: url)]
    }
  }

  static func kind(of url: URL) -> String {
    guard let type = UTType(filenameExtension: url.pathExtension) else { return "document" }
    if type.conforms(to: .image) { return "image" }
    if type.conforms(to: .movie) || type.conforms(to: .video) { return "video" }
    if type.conforms(to: .audio) { return "audio" }
    if type.conforms(to: .pdf) { return "pdf" }
    if type.conforms(to: .archive) { return "archive" }
    return "document"
  }

  static func file(_ uri: String) -> URL? {
    guard let url = URL(string: uri), url.isFileURL else { return nil }
    let folder = directory.standardizedFileURL.resolvingSymlinksInPath().path(percentEncoded: false)
    let target = url.standardizedFileURL.resolvingSymlinksInPath()
    guard target.deletingLastPathComponent().path(percentEncoded: false) == folder, FileManager.default.fileExists(atPath: target.path(percentEncoded: false)) else { return nil }
    return target
  }

  static func delete(_ uri: String) -> Bool {
    guard let url = file(uri) else { return false }
    return (try? FileManager.default.removeItem(at: url)) != nil
  }

  static func deleteAll() -> Int {
    list().compactMap { $0["uri"] as? String }.filter(delete).count
  }

  static func preview(_ uri: String) -> Bool {
    guard let url = file(uri) else { return false }
    let urls = list().compactMap { ($0["uri"] as? String).flatMap(file) }
    let source = DownloadPreviewSource(urls: urls.isEmpty ? [url] : urls)
    let controller = QLPreviewController()
    controller.dataSource = source
    controller.delegate = source
    controller.currentPreviewItemIndex = source.urls.firstIndex(of: url) ?? 0
    DownloadPreviewSource.showing = source
    PhonePages.present(controller)
    return true
  }
}

final class DownloadPreviewSource: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
  @MainActor static var showing: DownloadPreviewSource?
  let urls: [URL]

  init(urls: [URL]) {
    self.urls = urls
  }

  func numberOfPreviewItems(in controller: QLPreviewController) -> Int { urls.count }

  func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { urls[index] as NSURL }

  func previewControllerDidDismiss(_ controller: QLPreviewController) {
    MainActor.assumeIsolated { if Self.showing === self { Self.showing = nil } }
  }
}

public final class DownloadsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneDownloads")

    Events("onDownloadEvent")

    OnCreate {
      onMain {
        PhonePages.shared.downloadSink = { [weak self] event in self?.sendEvent("onDownloadEvent", event) }
      }
    }

    OnDestroy {
      onMain { PhonePages.shared.downloadSink = nil }
    }

    AsyncFunction("active") { () -> [[String: Any?]] in
      MainActor.assumeIsolated { PhonePages.shared.engine.downloads.progress.map(PagePayloads.download) }
    }.runOnQueue(.main)

    AsyncFunction("cancel") { (id: String) in
      MainActor.assumeIsolated {
        guard let uuid = UUID(uuidString: id) else { return }
        PhonePages.shared.engine.downloads.cancel(uuid)
      }
    }.runOnQueue(.main)

    AsyncFunction("open") { (uri: String) -> Bool in
      MainActor.assumeIsolated {
        guard let url = URL(string: uri), url.isFileURL, FileManager.default.fileExists(atPath: url.path(percentEncoded: false)) else { return false }
        PhonePages.present(UIActivityViewController(activityItems: [url], applicationActivities: nil))
        return true
      }
    }.runOnQueue(.main)

    AsyncFunction("files") { () -> [[String: Any]] in
      MainActor.assumeIsolated { DownloadedFiles.list() }
    }.runOnQueue(.main)

    AsyncFunction("delete") { (uri: String) -> Bool in
      MainActor.assumeIsolated { DownloadedFiles.delete(uri) }
    }.runOnQueue(.main)

    AsyncFunction("deleteAll") { () -> Int in
      MainActor.assumeIsolated { DownloadedFiles.deleteAll() }
    }.runOnQueue(.main)

    AsyncFunction("preview") { (uri: String) -> Bool in
      MainActor.assumeIsolated { DownloadedFiles.preview(uri) }
    }.runOnQueue(.main)
  }
}
