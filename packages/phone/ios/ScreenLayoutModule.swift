import ExpoModulesCore
import SwiftUI
import UIKit

public final class ScreenLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneScreenLayout")

    Function("forcedCanvas") { () -> String? in
      ScreenLayoutProbeView.forcedMode?.rawValue
    }

    View(ScreenLayoutProbeView.self) {
      Events("onLayoutChange")
    }
  }
}

final class ScreenLayoutProbeView: ExpoView {
  static let forcedMode: DuoCanvas.Mode? = PhoneTestBuild.isOn ? UserDefaults.standard.string(forKey: "ArdiaDuoCanvas").flatMap(DuoCanvas.Mode.init(argument:)) : nil

  let onLayoutChange = EventDispatcher()
  private let host = UIHostingController(rootView: FoldProbe(onChange: { _, _ in }))
  private var space = ScreenSpace()
  private var reported: NSDictionary?
  private var reportPending = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    accessibilityElementsHidden = true
    host.view.backgroundColor = .clear
    host.view.isUserInteractionEnabled = false
    host.sizingOptions = []
    host.rootView = FoldProbe { [weak self] hinge, divisions in
      guard let self else { return }
      space.hinge = hinge
      space.divisions = divisions
      report()
    }
    addSubview(host.view)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) { (view: ScreenLayoutProbeView, _: UITraitCollection) in
        view.readVerticalBarEdge()
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    host.view.frame = bounds
    readGeometry()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    readGeometry()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    readVerticalBarEdge()
  }

  private func readGeometry() {
    let insets = safeAreaInsets
    let rightToLeft = effectiveUserInterfaceLayoutDirection == .rightToLeft
    space.size = CGSize(width: max(bounds.width - insets.left - insets.right, 0), height: max(bounds.height - insets.top - insets.bottom, 0))
    space.safeInsets = ScreenSpace.Insets(top: insets.top, leading: rightToLeft ? insets.right : insets.left, bottom: insets.bottom, trailing: rightToLeft ? insets.left : insets.right)
    report()
  }

  private func readVerticalBarEdge() {
    guard #available(iOS 27.1, *) else { return }
    switch traitCollection.verticalBarEdge {
    case .leading: space.verticalBarEdge = .leading
    case .trailing: space.verticalBarEdge = .trailing
    default: space.verticalBarEdge = nil
    }
    report()
  }

  static func logLine(_ payload: [String: Any]) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else { return "\(payload)" }
    return String(decoding: data, as: UTF8.self)
  }

  private func report() {
    guard !reportPending else { return }
    reportPending = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      reportPending = false
      send()
    }
  }

  private func send() {
    guard window != nil, space.size.width > 0, space.size.height > 0 else { return }
    let payload = ScreenLayoutReport.payload(space: space, forced: Self.forcedMode)
    let dictionary = payload as NSDictionary
    guard reported != dictionary else { return }
    reported = dictionary
    if PhoneTestBuild.isOn { NSLog("ARDIA_SCREEN %@", Self.logLine(payload)) }
    onLayoutChange(payload)
  }
}

struct FoldProbe: View {
  let onChange: (ScreenSpace.Hinge, [CGRect]) -> Void
  @State private var hinge = ScreenSpace.Hinge.none
  @State private var divisions: [CGRect] = []

  var body: some View {
    Color.clear
      .modifier(DivisionProbe(divisions: $divisions))
      .ignoresSafeArea(.keyboard)
      .modifier(HingeProbe(hinge: $hinge))
      .allowsHitTesting(false)
      .accessibilityHidden(true)
      .onChange(of: hinge) { _, hinge in onChange(hinge, divisions) }
      .onChange(of: divisions) { _, divisions in onChange(hinge, divisions) }
  }
}

private struct DivisionProbe: ViewModifier {
  @Binding var divisions: [CGRect]

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      content.onGeometryChange(for: [CGRect].self) { proxy in
        proxy.reservedRegions(kind: .division, layoutDirectionBehavior: .fixed).filter(\.isActive).map(\.frame)
      } action: { divisions = $0 }
    } else {
      content
    }
  }
}

private struct HingeProbe: ViewModifier {
  @Binding var hinge: ScreenSpace.Hinge

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      content.onHingeChange { _, context in
        hinge = Self.hinge(context.hinge)
      }
    } else {
      content
    }
  }

  @available(iOS 27.1, *)
  private static func hinge(_ hinge: DeviceHinge?) -> ScreenSpace.Hinge {
    guard let status = hinge?.status else { return .none }
    switch status {
    case .closed: return .closed
    case .partiallyOpen: return .partiallyOpen
    case .fullyOpen: return .fullyOpen
    default: return .none
    }
  }
}
