import ArdiaBrowser
import CryptoKit
import ExpoModulesCore
import Foundation
import Observation
import SwiftData
import UIKit
import WebKit

@MainActor
final class PageWatcher {
  let page: WebTab
  private weak var pages: PhonePages?
  private let send: (String, [String: Any?]) -> Void
  private let visualChange: (PageVisuals.Change) -> Void
  private var generation = 0
  private var sentState: NSDictionary?
  private var sentRequest: UUID?
  private var observedWebView: ObjectIdentifier?
  private var fullscreen: NSKeyValueObservation?
  private var visualWatch: [NSKeyValueObservation] = []
  private var isFullscreen = false

  init(page: WebTab, pages: PhonePages, send: @escaping (String, [String: Any?]) -> Void, visualChange: @escaping (PageVisuals.Change) -> Void) {
    self.page = page
    self.pages = pages
    self.send = send
    self.visualChange = visualChange
    observe(generation: 0)
  }

  func stop() {
    generation += 1
    fullscreen = nil
    visualWatch = []
  }

  func resend() {
    sentState = nil
    emit()
  }

  private func observe(generation: Int) {
    withObservationTracking {
      emit()
    } onChange: { [weak self] in
      Task { @MainActor [weak self] in
        guard let self, self.generation == generation else { return }
        self.generation += 1
        self.observe(generation: self.generation)
      }
    }
  }

  private func emit() {
    guard let pages else { return }
    let webView = page.webView
    let identity = webView.map(ObjectIdentifier.init)
    if identity != observedWebView {
      observedWebView = identity
      if let webView {
        pages.applyUserAgent(page)
        webView.isInspectable = pages.engine.isInspectable
        fullscreen = webView.observe(\.fullscreenState, options: [.new]) { [weak self] view, _ in
          MainActor.assumeIsolated { self?.fullscreenChanged(view.fullscreenState) }
        }
        watchVisuals(webView)
      } else {
        fullscreen = nil
        visualWatch = []
      }
    }
    let state = pages.state(page)
    let comparable = state as NSDictionary
    if comparable != sentState {
      sentState = comparable
      send("page.state", ["state": state])
    }
    let request = page.request.flatMap { $0.isAnswered ? nil : $0 }
    if request?.id != sentRequest {
      sentRequest = request?.id
      send("page.request", ["request": request.map(PagePayloads.request)])
    }
  }

  private func watchVisuals(_ webView: WKWebView) {
    let report: (PageVisuals.Change) -> Void = { [weak self] change in
      MainActor.assumeIsolated { self?.visualChange(change) }
    }
    visualWatch = [
      webView.scrollView.observe(\.contentOffset, options: [.old, .new]) { _, change in
        if change.oldValue != change.newValue { report(.scrolled) }
      },
      webView.scrollView.observe(\.contentSize, options: [.old, .new]) { _, change in
        if change.oldValue != change.newValue { report(.laidOut) }
      },
      webView.layer.observe(\.bounds, options: [.old, .new]) { _, change in
        if change.oldValue?.size != change.newValue?.size { report(.resized) }
      },
    ]
  }

  private func fullscreenChanged(_ state: WKWebView.FullscreenState) {
    let now = state == .enteringFullscreen || state == .inFullscreen
    guard now != isFullscreen else { return }
    isFullscreen = now
    send("page.fullscreen", ["isFullscreen": now])
  }
}
