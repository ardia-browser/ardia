import Foundation

final class PluginPageGate {
  private let bind: () -> Void
  private let unbind: () -> Void
  private let load: () -> Void
  private var hasPage = false
  private var waitingLoad = false
  private(set) var bound = false

  init(bind: @escaping () -> Void, unbind: @escaping () -> Void, load: @escaping () -> Void) {
    self.bind = bind
    self.unbind = unbind
    self.load = load
  }

  func pageCreated(inWindow: Bool) {
    pageRemoved()
    hasPage = true
    if inWindow { bindNow() }
  }

  func pageRemoved() {
    if bound { unbindNow() }
    hasPage = false
    waitingLoad = false
  }

  func wantsLoad() {
    guard hasPage else { return }
    if bound { load() } else { waitingLoad = true }
  }

  func windowChanged(inWindow: Bool) {
    if !inWindow {
      if bound { unbindNow() }
      return
    }
    guard hasPage, !bound else { return }
    bindNow()
    if waitingLoad {
      waitingLoad = false
      load()
    }
  }

  private func bindNow() {
    bound = true
    bind()
  }

  private func unbindNow() {
    bound = false
    unbind()
  }
}
