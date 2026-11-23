import AppKit
import Foundation

extension VaultPasskeys {
  func handOff(_ entry: Pending, view: ArdiaWebView, provider: String, extensionId: String, allow: String?) -> [String: Any] {
    var answer: [String: Any] = ["delegate": extensionId]
    if let allow { answer["allow"] = allow }
    entry.handingOff = (provider, extensionId)
    entry.notice = nil
    guard reply(view, frame: entry.frameId, origin: entry.origin, pageId: entry.pageId, answer) else {
      finish(entry, answer: nil, outcome: .cancelled)
      return ["ok": false, "error": "gone"]
    }
    emitDone(tabId: entry.tabId, requestId: entry.id, outcome: .handingOff, stamp: entry.stamp)
    return ["ok": true]
  }

  func delegated(view: ArdiaWebView, frame: String, intake: Intake) {
    guard let entry = pending.values.first(where: { $0.view === view && $0.frameId == frame && $0.pageId == intake.pageId }), let handing = entry.handingOff
    else { return }
    switch intake.outcome {
    case "done":
      let created = entry.request.kind == .create
      finish(entry, answer: nil, outcome: created ? .created : .used, via: handing.extensionId)
      if created { Task { await VaultBroker.shared.refetchItems(handing.provider) } }
    case "rejected":
      finish(entry, answer: nil, outcome: .refused, via: handing.extensionId)
    case "returned":
      entry.handingOff = nil
      entry.notice = Notice(kind: "returned", provider: handing.provider)
      entry.choosing = false
      start(entry)
    default: break
    }
  }

  func providersLocked(_ ids: Set<String>?) {
    for entry in pending.values where entry.systemFor.map({ ids?.contains($0) ?? true }) == true { VaultSystemPasskeys.cancelRunning() }
  }


  func answerFromSystem(_ entry: Pending, view: ArdiaWebView, provider: String?, direct: Bool) async -> [String: Any] {
    guard VaultSystemPasskeys.available, let window = view.window else {
      if direct { finish(entry, answer: ["fallback": true], outcome: .fallback) }
      return ["ok": false, "error": "unavailable"]
    }
    entry.busy = true
    entry.system = true
    entry.systemFor = provider
    defer {
      entry.busy = false
      entry.system = false
      entry.systemFor = nil
    }
    let via = provider.map { "system:\($0)" }
    let result = await VaultSystemPasskeys.perform(entry.request, site: entry.site, origin: entry.origin, window: window)
    guard pending[entry.id] === entry, view.passkeyOriginIsCurrent(entry.origin) else { return ["ok": false, "error": "gone"] }
    switch result {
    case .credential(let credential):
      finish(entry, answer: ["credential": credential], outcome: entry.request.kind == .create ? .created : .used, via: via)
      return ["ok": true]
    case .excluded:
      finish(entry, answer: ["error": "InvalidStateError"], outcome: .refused, via: via)
      return ["ok": true]
    case .cancelled:
      if direct { finish(entry, answer: ["error": "NotAllowedError"], outcome: .refused, via: via) }
      return ["ok": false, "error": "declined"]
    case .failed:
      guard let provider else { return ["ok": false, "error": "failed"] }
      if direct {
        entry.notice = Notice(kind: "systemFailed", provider: provider)
        start(entry)
      }
      return ["ok": false, "error": "failed", "provider": provider]
    }
  }
}
