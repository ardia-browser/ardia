import ArdiaSync
import AVFoundation
import ExpoModulesCore
import UIKit
import VisionKit

public final class ScanModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaPhoneScan")

    AsyncFunction("permission") { () -> [String: Any] in
      ScanAccess.answer(ScanAccess.status())
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      guard ScanAccess.hasCamera else {
        promise.resolve(ScanAccess.answer(.unsupported))
        return
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined else {
        promise.resolve(ScanAccess.answer(ScanAccess.status()))
        return
      }
      AVCaptureDevice.requestAccess(for: .video) { _ in
        promise.resolve(ScanAccess.answer(ScanAccess.status()))
      }
    }

    View(ScanView.self) {
      Events("onCode", "onRejected", "onError")

      Prop("active") { (view: ScanView, active: Bool?) in
        view.isActive = active ?? true
      }
    }
  }
}

enum ScanAccess {
  enum Status: String {
    case granted
    case denied
    case undetermined
    case unsupported
  }

  static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

  static func status() -> Status {
    guard hasCamera else { return .unsupported }
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return .granted
    case .notDetermined: return .undetermined
    default: return .denied
    }
  }

  static func answer(_ status: Status) -> [String: Any] {
    ["status": status.rawValue, "canAskAgain": status == .undetermined]
  }
}

final class SyncCodeJudge {
  enum Verdict: Equatable {
    case accept(String)
    case reject
    case repeated
  }

  private var lastPayload: String?

  func judge(_ payload: String) -> Verdict {
    guard payload != lastPayload else { return .repeated }
    lastPayload = payload
    return SyncService.check(phrase: payload).isValid ? .accept(payload.trimmingCharacters(in: .whitespacesAndNewlines)) : .reject
  }
}

final class ScanView: ExpoView, AVCaptureMetadataOutputObjectsDelegate, DataScannerViewControllerDelegate {
  let onCode = EventDispatcher()
  let onRejected = EventDispatcher()
  let onError = EventDispatcher()

  var isActive = true {
    didSet { update() }
  }

  private let queue = DispatchQueue(label: "com.ardia.phone.scan")
  private let preview = AVCaptureVideoPreviewLayer()
  private var session: AVCaptureSession?
  private let judge = SyncCodeJudge()
  private var reported: String?
  private var interruption: NSObjectProtocol?
  private var scanner: DataScannerViewController?

  static var usesVisionKit: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black
    preview.videoGravity = .resizeAspectFill
    layer.addSublayer(preview)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    preview.frame = bounds
    scanner?.view.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    update()
  }

  private func update() {
    if isActive && window != nil { start() } else { stop() }
  }

  private func start() {
    guard session == nil, scanner == nil else { return }
    switch ScanAccess.status() {
    case .unsupported: return fail("unsupported")
    case .denied, .undetermined: return fail("permission")
    case .granted: break
    }
    if Self.usesVisionKit, startVisionKit() { return }
    guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device) else { return fail("camera") }
    let capture = AVCaptureSession()
    let output = AVCaptureMetadataOutput()
    guard capture.canAddInput(input), capture.canAddOutput(output) else { return fail("camera") }
    capture.addInput(input)
    capture.addOutput(output)
    guard output.availableMetadataObjectTypes.contains(.qr) else { return fail("unsupported") }
    output.metadataObjectTypes = [.qr]
    output.setMetadataObjectsDelegate(self, queue: .main)
    preview.session = capture
    session = capture
    reported = nil
    interruption = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: capture, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.fail("camera") }
    }
    queue.async { capture.startRunning() }
  }

  private func startVisionKit() -> Bool {
    guard let host = hostController() else { return false }
    let made = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isPinchToZoomEnabled: true,
      isGuidanceEnabled: false,
      isHighlightingEnabled: true
    )
    made.delegate = self
    host.addChild(made)
    made.view.frame = bounds
    made.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    addSubview(made.view)
    made.didMove(toParent: host)
    do {
      try made.startScanning()
    } catch {
      remove(made)
      return false
    }
    scanner = made
    reported = nil
    return true
  }

  private func hostController() -> UIViewController? {
    var responder: UIResponder? = self
    while let next = responder?.next {
      if let controller = next as? UIViewController { return controller }
      responder = next
    }
    return nil
  }

  private func remove(_ made: DataScannerViewController) {
    made.stopScanning()
    made.willMove(toParent: nil)
    made.view.removeFromSuperview()
    made.removeFromParent()
  }

  nonisolated func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
    MainActor.assumeIsolated {
      for item in addedItems {
        guard case .barcode(let barcode) = item, let payload = barcode.payloadStringValue else { continue }
        received(payload)
        return
      }
    }
  }

  nonisolated func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
    MainActor.assumeIsolated { fail("camera") }
  }

  private func stop() {
    if let made = scanner {
      scanner = nil
      remove(made)
    }
    guard let capture = session else { return }
    session = nil
    preview.session = nil
    if let interruption { NotificationCenter.default.removeObserver(interruption) }
    interruption = nil
    queue.async { capture.stopRunning() }
  }

  private func fail(_ code: String) {
    guard reported != code else { return }
    reported = code
    onError(["code": code])
  }

  nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
    let payloads = objects.compactMap { ($0 as? AVMetadataMachineReadableCodeObject).flatMap { $0.type == .qr ? $0.stringValue : nil } }
    guard let payload = payloads.first else { return }
    MainActor.assumeIsolated { received(payload) }
  }

  private func received(_ payload: String) {
    switch judge.judge(payload) {
    case .accept(let phrase): onCode(["text": phrase])
    case .reject: onRejected()
    case .repeated: break
    }
  }
}
