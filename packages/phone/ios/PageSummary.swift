import ArdiaBrowser
import Foundation
import FoundationModels
import Observation
import UIKit
import WebKit

@MainActor
@Observable
final class PageSummarySession: Identifiable {
  enum Trigger: String {
    case pinch
    case menu
  }

  enum Phase: Equatable {
    case reading
    case writing
    case done
    case interrupted
    case failed(String)
  }

  enum Writer: String {
    case onDevice = "on_device"
    case excerpts
  }

  static let responseTokens = 320
  static let instructionTokens = 120
  static let charactersPerToken = 3

  let id = UUID()
  let trigger: Trigger
  let page: UUID
  let navigation: Int
  let revision: Int
  @ObservationIgnored weak var source: WKWebView?
  private(set) var title: String
  private(set) var phase: Phase = .reading
  private(set) var text = ""
  private(set) var writer: Writer?
  private(set) var note: String?
  @ObservationIgnored var onSettled: ((PageSummarySession) -> Void)?
  @ObservationIgnored private var task: Task<Void, Never>?

  init(trigger: Trigger, tab: WebTab) {
    self.trigger = trigger
    page = tab.id
    navigation = tab.navigationGeneration
    revision = PageSummarySwitch.shared.revision
    source = tab.webView
    title = tab.title
  }

  var outcome: String {
    if case .failed = phase { return "failed" }
    if phase == .interrupted { return "failed" }
    return writer?.rawValue ?? "failed"
  }

  func outline(finished: Bool) -> PageSummaryOutline {
    PageSummaryOutline(text, finished: finished, format: writer == .excerpts ? .excerpts : .written)
  }

  func isCurrent(for tab: WebTab?) -> Bool {
    guard let tab, let source, PageSummarySwitch.shared.isCurrent(revision) else { return false }
    return tab.id == page && tab.navigationGeneration == navigation && tab.webView === source
  }

  func start(_ tab: WebTab) {
    guard task == nil else { return }
    task = Task { [weak self] in await self?.run(tab) }
  }

  func cancel() {
    onSettled = nil
    task?.cancel()
    task = nil
  }

  private func run(_ tab: WebTab) async {
    let content: ReadableContent
    do {
      content = try await tab.readableContent()
    } catch {
      return settle(failure: String(localized: "Couldn’t read this page."), tab: tab)
    }
    guard !Task.isCancelled, isCurrent(for: tab) else { return }
    if !content.title.isEmpty { title = content.title }
    guard PageSummaryDigest.isSummarizable(content) else {
      return settle(failure: String(localized: "There isn’t enough text on this page to summarize."), tab: tab)
    }
    phase = .writing
    let interrupted = await write(content)
    guard !Task.isCancelled, isCurrent(for: tab) else { return }
    if outline(finished: true).isEmpty { return settle(failure: String(localized: "Couldn’t summarize this page."), tab: tab) }
    phase = interrupted ? .interrupted : .done
    onSettled?(self)
  }

  private func settle(failure: String, tab: WebTab) {
    guard !Task.isCancelled, isCurrent(for: tab) else { return }
    text = ""
    phase = .failed(failure)
    onSettled?(self)
  }

  private func write(_ content: ReadableContent) async -> Bool {
    let model = SystemLanguageModel.default
    guard case .available = model.availability else {
      quote(content, reason: Self.unavailableReason(model.availability))
      return false
    }
    let budget = max((model.contextSize - Self.responseTokens - Self.instructionTokens) * Self.charactersPerToken, 2000)
    for share in [budget, budget / 2] {
      do {
        try await stream(model: model, prompt: PageSummaryDigest.prompt(content, characterBudget: share))
        if PageSummaryOutline(text).isEmpty {
          text = ""
          continue
        }
        writer = .onDevice
        note = String(localized: "Written on this iPhone by Apple Intelligence. Nothing left the phone.")
        return false
      } catch {
        if Task.isCancelled { return false }
        let shown = PageSummaryOutline.wholeLines(text)
        if !PageSummaryOutline(shown).isEmpty {
          text = shown
          writer = .onDevice
          note = String(localized: "Apple Intelligence stopped before it finished, so this summary is incomplete. Nothing left the phone.")
          return true
        }
        text = ""
      }
    }
    quote(content, reason: String(localized: "Apple Intelligence couldn’t summarize this page, so here are its key lines."))
    return false
  }

  private func stream(model: SystemLanguageModel, prompt: String) async throws {
    let session = LanguageModelSession(model: model, instructions: PageSummaryDigest.instructions)
    let options = GenerationOptions(temperature: 0.2, maximumResponseTokens: Self.responseTokens)
    for try await snapshot in session.streamResponse(to: prompt, options: options) {
      try Task.checkCancellation()
      text = snapshot.content
    }
  }

  private func quote(_ content: ReadableContent, reason: String) {
    text = PageSummaryDigest.excerpts(content)
    writer = .excerpts
    note = reason
  }

  static func unavailableReason(_ availability: SystemLanguageModel.Availability) -> String {
    switch availability {
    case .unavailable(.appleIntelligenceNotEnabled):
      String(localized: "Turn on Apple Intelligence in Settings for a written summary. Until then, here are the page’s key lines.")
    case .unavailable(.modelNotReady):
      String(localized: "Apple Intelligence is still downloading. Until it’s ready, here are the page’s key lines.")
    default:
      String(localized: "This iPhone can’t run Apple Intelligence, so here are the page’s key lines.")
    }
  }
}

extension PageSummarySwitch {
  static let shared = PageSummarySwitch(defaults: .standard)
}

@MainActor
final class PagePinchWatcher: NSObject, UIGestureRecognizerDelegate {
  struct Hold {
    var scale: Double
    var shift: CGPoint
  }

  var moment: (() -> PagePinch.Moment?)?
  var mayBegin: (() -> Bool)?
  var onTaken: (() -> Void)?
  var onHeld: ((Hold) -> Void)?
  var onLetGo: ((_ fired: Bool) -> Void)?
  weak var zoomer: UIScrollView?

  private lazy var recognizer = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
  private var pinch: PagePinch?
  private var start = CGPoint.zero
  private var taken = false
  private var engaged = false
  private weak var heldZoomer: UIScrollView?
  private var heldZoomerBounced = true
  private lazy var feedback = UIImpactFeedbackGenerator(style: .soft, view: recognizer.view ?? UIView())

  init(container: UIView) {
    super.init()
    recognizer.delegate = self
    recognizer.cancelsTouchesInView = false
    recognizer.delaysTouchesBegan = false
    recognizer.delaysTouchesEnded = false
    container.addGestureRecognizer(recognizer)
  }

  var isHolding: Bool { taken }

  func reset(notifying: Bool = true) {
    let wasTaken = taken && notifying
    pinch = nil
    taken = false
    engaged = false
    freeZoomer()
    if recognizer.state == .began || recognizer.state == .changed {
      recognizer.isEnabled = false
      recognizer.isEnabled = true
    }
    if wasTaken { onLetGo?(false) }
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === recognizer, mayBegin?() != false, let moment = moment?() else { return false }
    pinch = PagePinch(at: moment, scale: Double(recognizer.scale))
    taken = false
    engaged = false
    if pinch != nil {
      start = recognizer.location(in: recognizer.view)
      feedback.prepare()
    }
    return pinch != nil
  }

  private func take() {
    taken = true
    if let zoomer {
      heldZoomer = zoomer
      heldZoomerBounced = zoomer.bouncesZoom
      zoomer.bouncesZoom = false
    }
    holdZoomerAtMinimum()
    onTaken?()
  }

  private func holdZoomerAtMinimum() {
    guard let zoomer = heldZoomer, zoomer.zoomScale != zoomer.minimumZoomScale else { return }
    zoomer.setZoomScale(zoomer.minimumZoomScale, animated: false)
  }

  private func freeZoomer() {
    heldZoomer?.bouncesZoom = heldZoomerBounced
    heldZoomer = nil
  }

  @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
    let scale = Double(recognizer.scale)
    switch recognizer.state {
    case .changed:
      guard var pinch, recognizer.numberOfTouches >= 2 else { return }
      pinch.moved(to: scale)
      self.pinch = pinch
      if pinch.wentOutward {
        if taken { reset() }
        return
      }
      if !taken, scale < 1 { take() }
      guard taken else { return }
      holdZoomerAtMinimum()
      let nowEngaged = PagePinch.isEngaged(at: scale)
      if nowEngaged != engaged {
        engaged = nowEngaged
        feedback.impactOccurred(intensity: nowEngaged ? 0.6 : 0.3)
      }
      let at = recognizer.location(in: recognizer.view)
      onHeld?(Hold(scale: scale, shift: CGPoint(x: at.x - start.x, y: at.y - start.y)))
    case .ended, .cancelled, .failed:
      guard var pinch else { return }
      let wasTaken = taken
      self.pinch = nil
      taken = false
      engaged = false
      freeZoomer()
      pinch.moved(to: scale)
      let ending: PagePinch.Ending = recognizer.state == .ended ? .ended : recognizer.state == .cancelled ? .cancelled : .failed
      let fired = wasTaken && (moment?()).map { pinch.fires(ending, velocity: Double(recognizer.velocity), at: $0) } == true
      if fired { feedback.impactOccurred(intensity: 0.5) }
      if wasTaken { onLetGo?(fired) }
    default:
      break
    }
  }
}
