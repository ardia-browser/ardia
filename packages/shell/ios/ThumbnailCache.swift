import AppKit
import ArdiaCore
import CryptoKit
import ImageIO
import QuickLookThumbnailing

actor ThumbnailCache {
  static let shared = ThumbnailCache()

  private static let largestPixels = 2048.0
  private static let fileLimit = 500
  private static let byteLimit = 100 * 1024 * 1024
  private static let trimShare = 0.8
  private static let writesBetweenTrims = 25
  private static let memoryLimit = 64
  private static let forgottenLimit = 4096
  private static let sourceAttribute = "com.ardia.thumbnail.source"

  private struct Source: Equatable {
    let path: String
    let stamp: Double
    let size: Int

    var tag: String { "\(stamp)|\(size)|\(path)" }

    init(path: String, stamp: Double, size: Int) {
      self.path = path
      self.stamp = stamp
      self.size = size
    }

    init?(tag: String) {
      let parts = tag.split(separator: "|", maxSplits: 2, omittingEmptySubsequences: false)
      guard parts.count == 3, let stamp = Double(parts[0]), let size = Int(parts[1]), parts[2].hasPrefix("/") else { return nil }
      self.init(path: String(parts[2]), stamp: stamp, size: size)
    }

    static func current(at path: String) -> Source? {
      let url = URL(fileURLWithPath: path)
      guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey, .isRegularFileKey]),
            values.isRegularFile == true else { return nil }
      return Source(path: url.standardizedFileURL.path, stamp: values.contentModificationDate?.timeIntervalSince1970 ?? 0, size: values.fileSize ?? 0)
    }
  }

  private let folder: URL
  private var inFlight: [String: Task<Data?, Never>] = [:]
  private var inMemory: [String: (source: String, uri: String)] = [:]
  private var memoryOrder: [String] = []
  private var writesSinceTrim = 0
  private var generation = 0
  private var everythingForgottenAt = 0
  private var forgottenAt: [String: Int] = [:]

  private init() {
    if let custom = LaunchConfig.shared.dataDirectory {
      folder = URL(fileURLWithPath: custom, isDirectory: true).appendingPathComponent("Caches/Thumbnails", isDirectory: true)
    } else {
      let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      folder = caches.appendingPathComponent("\(Bundle.main.bundleIdentifier ?? "Ardia")/Thumbnails", isDirectory: true)
    }
  }

  func thumbnail(path: String, points: Double, scale: Double, ephemeral: Bool) async -> String? {
    guard points > 0, points * scale <= Self.largestPixels, let source = Source.current(at: path) else { return nil }
    let pixels = Int((points * scale).rounded())
    let name = Self.digest("\(source.path)|\(source.stamp)|\(source.size)|\(pixels)")
    if ephemeral {
      if let kept = rememberedInMemory(name) { return kept }
    } else {
      let file = folder.appendingPathComponent(name).appendingPathExtension("png")
      if FileManager.default.fileExists(atPath: file.path) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: file.path)
        return file.absoluteString
      }
    }
    let started = generation
    let url = URL(fileURLWithPath: path)
    let png: Data?
    if let running = inFlight[name] {
      png = await running.value
    } else {
      let task = Task.detached(priority: .utility) { await Self.render(url, points: points, scale: scale) }
      inFlight[name] = task
      png = await task.value
      inFlight[name] = nil
    }
    guard let png, !forgotten(source.path, since: started) else { return nil }
    if ephemeral {
      let uri = "data:image/png;base64,\(png.base64EncodedString())"
      keepInMemory(name, source: source.path, uri: uri)
      return uri
    }
    let file = folder.appendingPathComponent(name).appendingPathExtension("png")
    guard Self.write(png, to: file, folder: folder, source: source) else { return nil }
    wrote()
    return file.absoluteString
  }

  func forget(paths: [String]?) {
    generation += 1
    let folder = self.folder
    guard let paths else {
      everythingForgottenAt = generation
      forgottenAt.removeAll()
      inMemory.removeAll()
      memoryOrder.removeAll()
      try? FileManager.default.removeItem(at: folder)
      return
    }
    let gone = Set(paths.map { URL(fileURLWithPath: $0).standardizedFileURL.path })
    if forgottenAt.count + gone.count > Self.forgottenLimit {
      everythingForgottenAt = generation
      forgottenAt.removeAll()
    } else {
      for path in gone { forgottenAt[path] = generation }
    }
    for (name, entry) in inMemory where gone.contains(entry.source) { inMemory[name] = nil }
    memoryOrder.removeAll { inMemory[$0] == nil }
    Task.detached(priority: .utility) { Self.evict(in: folder) { gone.contains($0.path) } }
  }

  private func forgotten(_ path: String, since started: Int) -> Bool {
    everythingForgottenAt > started || (forgottenAt[path] ?? 0) > started
  }

  func trim() {
    writesSinceTrim = 0
    let folder = self.folder
    Task.detached(priority: .background) { Self.evict(in: folder) { _ in false } }
  }

  private func rememberedInMemory(_ name: String) -> String? {
    guard let entry = inMemory[name] else { return nil }
    memoryOrder.removeAll { $0 == name }
    memoryOrder.append(name)
    return entry.uri
  }

  private func keepInMemory(_ name: String, source: String, uri: String) {
    if inMemory.updateValue((source, uri), forKey: name) != nil { memoryOrder.removeAll { $0 == name } }
    memoryOrder.append(name)
    while memoryOrder.count > Self.memoryLimit { inMemory[memoryOrder.removeFirst()] = nil }
  }

  private func wrote() {
    writesSinceTrim += 1
    if writesSinceTrim >= Self.writesBetweenTrims { trim() }
  }

  private static func evict(in folder: URL, dropping forgotten: (Source) -> Bool) {
    let keys: [URLResourceKey] = [.contentModificationDateKey, .totalFileAllocatedSizeKey, .isRegularFileKey]
    guard let files = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: keys) else { return }
    var entries: [(url: URL, used: Date, bytes: Int)] = []
    for file in files {
      guard let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
      guard let source = source(of: file), !forgotten(source), Source.current(at: source.path) == source else {
        try? FileManager.default.removeItem(at: file)
        continue
      }
      entries.append((file, values.contentModificationDate ?? .distantPast, values.totalFileAllocatedSize ?? 0))
    }
    var bytes = entries.reduce(0) { $0 + $1.bytes }
    guard entries.count > fileLimit || bytes > byteLimit else { return }
    entries.sort { $0.used < $1.used }
    let keepFiles = Int(Double(fileLimit) * trimShare), keepBytes = Int(Double(byteLimit) * trimShare)
    var count = entries.count
    for entry in entries where count > keepFiles || bytes > keepBytes {
      guard (try? FileManager.default.removeItem(at: entry.url)) != nil else { continue }
      count -= 1
      bytes -= entry.bytes
    }
  }

  private static func source(of file: URL) -> Source? {
    file.withUnsafeFileSystemRepresentation { path -> Source? in
      guard let path else { return nil }
      let length = getxattr(path, sourceAttribute, nil, 0, 0, XATTR_NOFOLLOW)
      guard length > 0, length < 8192 else { return nil }
      var bytes = [UInt8](repeating: 0, count: length)
      guard getxattr(path, sourceAttribute, &bytes, length, 0, XATTR_NOFOLLOW) == length else { return nil }
      return Source(tag: String(decoding: bytes, as: UTF8.self))
    }
  }

  private static func write(_ png: Data, to file: URL, folder: URL, source: Source) -> Bool {
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try png.write(to: file, options: .atomic)
    } catch {
      return false
    }
    let tagged = file.withUnsafeFileSystemRepresentation { path -> Bool in
      guard let path else { return false }
      let tag = Array(source.tag.utf8)
      return setxattr(path, sourceAttribute, tag, tag.count, 0, XATTR_NOFOLLOW) == 0
    }
    if !tagged { try? FileManager.default.removeItem(at: file) }
    return tagged
  }

  private static func render(_ url: URL, points: Double, scale: Double) async -> Data? {
    let size = CGSize(width: points, height: points)
    let request = QLThumbnailGenerator.Request(fileAt: url, size: size, scale: scale, representationTypes: .thumbnail)
    guard let representation = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request) else { return nil }
    return NSBitmapImageRep(cgImage: representation.cgImage).representation(using: .png, properties: [:])
  }

  private static let uncached = [kCGImageSourceShouldCache: false] as CFDictionary

  static func pixelSize(_ path: String) -> [String: Int]? {
    guard path.hasPrefix("/"), !isDataless(URL(fileURLWithPath: path)),
          let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, uncached) else { return nil }
    let index = CGImageSourceGetPrimaryImageIndex(source)
    guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, uncached) as? [CFString: Any],
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
          width > 0, height > 0 else { return nil }
    let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
    let turned = (5...8).contains(orientation)
    return ["width": turned ? height : width, "height": turned ? width : height]
  }

  static func isDataless(_ url: URL) -> Bool {
    guard let values = try? url.resourceValues(forKeys: [.isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey]),
          values.isUbiquitousItem == true else { return false }
    return values.ubiquitousItemDownloadingStatus == .notDownloaded
  }

  private static func digest(_ text: String) -> String {
    SHA256.hash(data: Data(text.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
  }
}
