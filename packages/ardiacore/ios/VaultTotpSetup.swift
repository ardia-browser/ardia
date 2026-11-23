import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision
import os

struct VaultTotpOffer: Sendable {
  let uri: String
  let issuer: String
  let account: String
  let origin: String
  let at: Date
}

final class VaultCodeAnswer: @unchecked Sendable {
  let answer: ([String: String]?) -> Void
  let image: CGImage?

  init(_ answer: @escaping ([String: String]?) -> Void, image: CGImage?) {
    self.answer = answer
    self.image = image
  }
}

final class VaultPicture: @unchecked Sendable {
  let image: CGImage

  init(_ image: CGImage) { self.image = image }
}

enum VaultCodeSource: String, Sendable {
  case clipboard, image, page
}

enum VaultCodeReadError: String, Error, Sendable {
  case none, many, declined, unreadable
}

enum VaultTotpSetup {
  static let lifetime: TimeInterval = 600
  static let maxOffers = 8
  static let longestImageSide = 4096
  static let testImageName = "Verification Code.png"
  private static let offers = OSAllocatedUnfairLock(initialState: [String: VaultTotpOffer]())

  static func enable(_ enabled: Bool) {
    ArdiaWebView.setVaultCodeReader { image, text, origin, answer in
      Self.read(image: image, text: text, origin: origin, answer)
    }
    ArdiaWebView.setVaultCodeSetup(enabled)
    if !enabled { forgetAll() }
  }

  static func read(image: CGImage?, text: String?, origin: String, _ answer: @escaping ([String: String]?) -> Void) {
    let reply = VaultCodeAnswer(answer, image: image)
    DispatchQueue.global(qos: .userInitiated).async {
      var found: String?
      if let picture = reply.image {
        if case .one(let uri) = codes(in: picture) { found = uri }
      } else if let text {
        found = VaultTotpURI.setupURI(inText: text, origin: origin)
      }
      let offer = found.flatMap { Self.keep($0, origin: origin) }
      DispatchQueue.main.async { reply.answer(offer) }
    }
  }

  static func read(_ source: VaultCodeSource, origin: String, tabId: String?) async -> Result<[String: String], VaultCodeReadError> {
    let found: VaultTotpURI.Found
    switch source {
    case .clipboard:
      let text = await clipboardText()
      found = text.flatMap { VaultTotpURI.setupURI(inText: $0, origin: origin, allowingBareKey: origin.isEmpty) }.map { .one($0) } ?? .none
    case .image:
      guard let url = await imageFile() else { return .failure(.declined) }
      guard let read = await Task.detached(priority: .userInitiated, operation: { Self.picture(at: url).map(Self.codes) }).value else {
        return .failure(.unreadable)
      }
      found = read
    case .page:
      guard let tabId, let picture = await pagePicture(tabId) else { return .failure(.unreadable) }
      found = await Task.detached(priority: .userInitiated) { Self.codes(in: picture.image) }.value
    }
    switch found {
    case .none: return .failure(.none)
    case .many: return .failure(.many)
    case .one(let uri):
      guard let offer = keep(uri, origin: origin) else { return .failure(.none) }
      return .success(offer)
    }
  }

  private static func codes(in picture: CGImage) -> VaultTotpURI.Found {
    let request = VNDetectBarcodesRequest()
    request.symbologies = [.qr]
    guard (try? VNImageRequestHandler(cgImage: picture, options: [:]).perform([request])) != nil else { return .none }
    return VaultTotpURI.found(inPayloads: (request.results ?? []).compactMap(\.payloadStringValue))
  }

  @MainActor
  private static func clipboardText() -> String? {
    let text = VaultClipboard.board().string(forType: .string)
    guard let text, text.count <= VaultTotpSecret.longestText else { return nil }
    return text
  }

  @MainActor
  private static func imageFile() async -> URL? {
    if LaunchConfig.shared.background {
      guard let folder = LaunchConfig.shared.dataDirectory else { return nil }
      let url = URL(fileURLWithPath: folder, isDirectory: true).appendingPathComponent(testImageName)
      NSLog("[vaults] code image open panel (background mode, not shown), reading %@", url.lastPathComponent)
      return url
    }
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = false
    panel.canChooseDirectories = false
    panel.allowedContentTypes = [.image]
    panel.message = "Choose a picture of the QR code."
    return await withCheckedContinuation { (done: CheckedContinuation<URL?, Never>) in
      panel.begin { response in done.resume(returning: response == .OK ? panel.url : nil) }
    }
  }

  static func picture(at url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: longestImageSide,
      kCGImageSourceShouldCacheImmediately: false,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }

  @MainActor
  private static func pagePicture(_ tabId: String) async -> VaultPicture? {
    await withCheckedContinuation { (done: CheckedContinuation<VaultPicture?, Never>) in
      ArdiaWebView.copyVaultCodePicture(ofTab: tabId) { picture in done.resume(returning: picture.map(VaultPicture.init)) }
    }
  }

  static func keep(_ uri: String, origin: String) -> [String: String]? {
    guard let stored = VaultTotpURI.setupURI(uri), let names = VaultTotpURI.labels(stored) else { return nil }
    let token = UUID().uuidString
    let now = Date()
    offers.withLock { offers in
      offers = offers.filter { now.timeIntervalSince($0.value.at) < lifetime }
      while offers.count >= maxOffers, let oldest = offers.min(by: { $0.value.at < $1.value.at })?.key { offers[oldest] = nil }
      offers[token] = VaultTotpOffer(uri: stored, issuer: names.issuer, account: names.account, origin: origin, at: now)
    }
    return ["token": token, "issuer": names.issuer, "account": names.account]
  }

  static func offer(_ token: String) -> VaultTotpOffer? {
    offers.withLock { offers in
      guard let found = offers[token] else { return nil }
      guard Date().timeIntervalSince(found.at) < lifetime else {
        offers[token] = nil
        return nil
      }
      return found
    }
  }

  static func forget(_ token: String) {
    offers.withLock { $0[token] = nil }
  }

  static func forgetAll() {
    offers.withLock { $0 = [:] }
  }
}
