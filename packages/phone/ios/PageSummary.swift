import ArdiaBrowser
import ArdiaDesign
import Foundation
import FoundationModels
import Observation
import SwiftUI
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
    return writer?.rawValue ?? "failed"
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
    await write(content)
    guard !Task.isCancelled, isCurrent(for: tab) else { return }
    if text.isEmpty { return settle(failure: String(localized: "Couldn’t summarize this page."), tab: tab) }
    phase = .done
    onSettled?(self)
  }

  private func settle(failure: String, tab: WebTab) {
    guard !Task.isCancelled, isCurrent(for: tab) else { return }
    text = ""
    phase = .failed(failure)
    onSettled?(self)
  }

  private func write(_ content: ReadableContent) async {
    let model = SystemLanguageModel.default
    guard case .available = model.availability else {
      return quote(content, reason: Self.unavailableReason(model.availability))
    }
    let budget = max((model.contextSize - Self.responseTokens - Self.instructionTokens) * Self.charactersPerToken, 2000)
    for share in [budget, budget / 2] {
      do {
        try await stream(model: model, prompt: PageSummaryDigest.prompt(content, characterBudget: share))
        writer = .onDevice
        note = String(localized: "Written on this iPhone by Apple Intelligence. Nothing left the phone.")
        return
      } catch {
        if Task.isCancelled { return }
        text = ""
      }
    }
    quote(content, reason: String(localized: "Apple Intelligence couldn’t summarize this page, so here are its key lines."))
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
@Observable
final class PageSummaryPresenter {
  var session: PageSummarySession?
  var bottomInset: CGFloat = 0
  @ObservationIgnored var cardFrame: CGRect = .zero
  @ObservationIgnored var onDismiss: (() -> Void)?

  func dismiss() { onDismiss?() }
}

final class PageSummaryLayer: UIView {
  static let coordinateSpace = "ardiaPageSummary"

  let presenter: PageSummaryPresenter
  private let hosting: UIHostingController<PageSummaryOverlay>

  init(presenter: PageSummaryPresenter) {
    self.presenter = presenter
    hosting = UIHostingController(rootView: PageSummaryOverlay(presenter: presenter))
    super.init(frame: .zero)
    backgroundColor = .clear
    hosting.view.backgroundColor = .clear
    hosting.safeAreaRegions = []
    hosting.view.frame = bounds
    hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(hosting.view)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    presenter.session != nil && presenter.cardFrame.contains(point)
  }
}

struct PageSummaryOverlay: View {
  let presenter: PageSummaryPresenter
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { proxy in
      VStack(spacing: 0) {
        Spacer(minLength: 0)
        if let session = presenter.session {
          PageSummaryCard(session: session, maxHeight: max(proxy.size.height * 0.45, 160)) { presenter.dismiss() }
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(PageSummaryLayer.coordinateSpace)) } action: { presenter.cardFrame = $0 }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
            .padding(.bottom, presenter.bottomInset + 12)
            .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
            .id(session.id)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
    }
    .coordinateSpace(.named(PageSummaryLayer.coordinateSpace))
    .ignoresSafeArea()
    .environment(\.usesGlass, NativeChromeLook.shared.usesGlass)
  }
}

struct PageSummaryCard: View {
  let session: PageSummarySession
  let maxHeight: CGFloat
  let onClose: @MainActor () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      header
      ViewThatFits(in: .vertical) {
        content
        ScrollView { content }.scrollBounceBehavior(.basedOnSize)
      }
    }
    .padding(16)
    .frame(maxWidth: 560, maxHeight: maxHeight, alignment: .topLeading)
    .chromeSurface(in: .rect(cornerRadius: 24), interactive: false)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(Text("Summary"))
    .accessibilityAction(.escape) { onClose() }
    .onChange(of: session.phase) { _, phase in
      if phase == .done { UIAccessibility.post(notification: .announcement, argument: String(localized: "Summary ready")) }
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Summary")
          .font(.headline)
        if !session.title.isEmpty {
          Text(session.title)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      Spacer(minLength: 0)
      Button {
        onClose()
      } label: {
        Image(systemName: "xmark")
          .font(.footnote.weight(.semibold))
          .foregroundStyle(.secondary)
          .frame(width: 44, height: 44)
          .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .padding(.trailing, -12)
      .padding(.vertical, -12)
      .accessibilityLabel(Text("Close Summary"))
    }
    .contentShape(.rect)
    .gesture(DragGesture(minimumDistance: 12).onEnded { drag in
      if drag.translation.height > 48 { onClose() }
    })
  }

  @ViewBuilder
  private var content: some View {
    VStack(alignment: .leading, spacing: 8) {
      switch session.phase {
      case .failed(let message):
        Text(message)
          .font(.body)
          .foregroundStyle(.secondary)
      default:
        if session.text.isEmpty {
          HStack(spacing: 8) {
            ProgressView()
            Text("Summarizing…")
              .font(.body)
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        } else {
          ForEach(Array(ResearchAnswer.blocks(session.text).enumerated()), id: \.offset) { _, block in
            line(block)
          }
        }
      }
      if let note = session.note, session.phase == .done {
        Text(note)
          .font(.footnote)
          .foregroundStyle(.secondary)
          .padding(.top, 2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  @ViewBuilder
  private func line(_ block: ResearchAnswer.Block) -> some View {
    switch block {
    case .heading(let text):
      Text(text).font(.subheadline.weight(.semibold))
    case .bullet(let text):
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text("•").foregroundStyle(.secondary).accessibilityHidden(true)
        Text(ResearchAnswer.withoutCitations(text)).font(.body)
      }
    case .paragraph(let text):
      Text(ResearchAnswer.withoutCitations(text)).font(.body)
    }
  }
}

@MainActor
final class PagePinchWatcher: NSObject, UIGestureRecognizerDelegate {
  var moment: (() -> PagePinch.Moment?)?
  var onPinchedIn: (() -> Void)?
  var ignoresTouch: ((UITouch) -> Bool)?

  private lazy var recognizer = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
  private var pinch: PagePinch?
  private lazy var feedback = UIImpactFeedbackGenerator(style: .light, view: recognizer.view ?? UIView())

  init(container: UIView) {
    super.init()
    recognizer.delegate = self
    recognizer.cancelsTouchesInView = false
    recognizer.delaysTouchesBegan = false
    recognizer.delaysTouchesEnded = false
    container.addGestureRecognizer(recognizer)
  }

  func reset() {
    pinch = nil
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
    true
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    ignoresTouch?(touch) != true
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === recognizer, let moment = moment?() else { return false }
    pinch = PagePinch(at: moment, scale: Double(recognizer.scale))
    if pinch != nil { feedback.prepare() }
    return pinch != nil
  }

  @objc private func pinched(_ recognizer: UIPinchGestureRecognizer) {
    switch recognizer.state {
    case .changed:
      pinch?.moved(to: Double(recognizer.scale))
    case .ended, .cancelled, .failed:
      guard var pinch else { return }
      self.pinch = nil
      pinch.moved(to: Double(recognizer.scale))
      let ending: PagePinch.Ending = recognizer.state == .ended ? .ended : recognizer.state == .cancelled ? .cancelled : .failed
      guard let moment = moment?(), pinch.fires(ending, at: moment) else { return }
      feedback.impactOccurred(intensity: 0.7)
      onPinchedIn?()
    default:
      break
    }
  }
}
