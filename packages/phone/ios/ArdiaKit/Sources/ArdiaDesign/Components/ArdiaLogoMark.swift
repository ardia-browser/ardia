import SwiftUI

public struct ArdiaLogoMark: View {
  public var outline: Bool
  public var outlineWeight: CGFloat

  public init(outline: Bool = true, outlineWeight: CGFloat = 0.075) {
    self.outline = outline
    self.outlineWeight = outlineWeight
  }

  public var body: some View {
    Canvas { context, size in
      let width = outline ? size.width * outlineWeight : 0
      let shapes = LogoGeometry.shapes(in: CGRect(origin: .zero, size: size).insetBy(dx: width / 2 + 1, dy: width / 2 + 1))
      if outline {
        let style = StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
        for shape in shapes {
          context.stroke(shape.path, with: .color(.white), style: style)
          context.fill(shape.path, with: .color(.white))
        }
      }
      for shape in shapes {
        context.fill(shape.path, with: .linearGradient(
          Gradient(colors: [shape.top, shape.bottom]),
          startPoint: CGPoint(x: shape.path.boundingRect.midX, y: shape.path.boundingRect.minY),
          endPoint: CGPoint(x: shape.path.boundingRect.midX, y: shape.path.boundingRect.maxY)
        ))
      }
    }
    .aspectRatio(LogoGeometry.aspectRatio, contentMode: .fit)
    .accessibilityHidden(true)
  }
}

enum LogoGeometry {
  struct Shape {
    var path: Path
    var top: Color
    var bottom: Color
  }

  static let canvas = CGRect(x: 102, y: 102, width: 820, height: 820)
  static var aspectRatio: CGFloat { canvas.width / canvas.height }

  static func shapes(in rect: CGRect) -> [Shape] {
    let scale = min(rect.width / canvas.width, rect.height / canvas.height)
    let transform = CGAffineTransform(translationX: rect.minX, y: rect.minY)
      .scaledBy(x: scale, y: scale)
      .translatedBy(x: -canvas.minX, y: -canvas.minY)
    return [
      Shape(path: sun.applying(transform), top: Color(hex: 0xFFCB45), bottom: Color(hex: 0xF5A812)),
      Shape(path: backHill.applying(transform), top: Color(hex: 0x8DAF63), bottom: Color(hex: 0x5E7D3E)),
      Shape(path: frontHill.applying(transform), top: Color(hex: 0x17604B), bottom: Color(hex: 0x063528)),
    ]
  }

  static let sun = Path(ellipseIn: CGRect(x: 363.1, y: 102, width: 297.7, height: 297.6))

  static let backHill = path(svg: "M102 609.4C102 603.3 102 599.6 102 596.3C102 591.7 102 587.3 102.1 583.2C102.2 578.8 102.4 574.4 102.6 570.1C102.9 565.8 103.3 561.5 103.9 557.1C104.4 552.7 105.2 548.5 106.1 544.2C109.3 529.1 114.8 514.5 122.4 501C130 487.5 139.5 475.2 150.8 464.6C162 453.9 174.7 445 188.6 438.1C202.5 431.2 217.3 426.5 232.6 424C247.9 421.5 263.5 421.4 278.8 423.5C282 424 285.2 424.5 288.5 425.2C291.6 425.9 294.8 426.6 298 427.4C301.1 428.2 304.2 429.1 307.5 430.1C310.1 430.9 313.2 431.9 316.8 433.2C320.2 434.3 323.4 435.5 326.1 436.4C326.8 436.7 327.5 437 328.2 437.2C328.9 437.5 329.6 437.8 330.3 438C331 438.3 331.7 438.5 332.4 438.8C333.1 439.1 333.8 439.3 334.5 439.6C335.2 439.9 335.9 440.2 336.6 440.4C337.3 440.7 338 441 338.7 441.3C339.4 441.5 340.1 441.8 340.8 442.1C341.5 442.4 342.2 442.7 342.9 443C348.8 445.4 354.6 447.9 360.4 450.6C366.3 453.3 372 456 377.6 458.8C383.4 461.7 389.1 464.5 394.7 467.4C400.3 470.4 406 473.3 411.6 476.3C417.3 479.2 422.9 482.1 428.6 484.9C434.3 487.7 440 490.5 445.9 493.1C451.7 495.7 457.5 498.2 463.5 500.5C469.5 502.9 475.4 505 481.5 507C509.2 516.1 538.1 521.4 567.3 522.8C567.8 522.8 568.2 522.8 568.7 522.8C569.1 522.8 569.4 522.9 569.8 522.9C572 525.4 574.1 527.9 576.3 530.4C542.5 559.8 507.2 587.4 470.5 613.1C433.7 638.7 395.7 662.4 356.4 684.1C317.2 705.7 276.8 725.3 235.5 742.7C194.2 760 149.3 766.6 106.2 778.5C104.7 767.5 103.8 756.3 103.2 744.4C102.5 730.6 102.2 715.7 102 699.3C102 687 102 673.1 102 650.3C102 636.7 102 623 102 609.4Z")

  static let frontHill = path(svg: "M106.3 779C150.5 765.2 194.1 749.4 236.6 731.3C279.2 713.2 320.7 692.8 361 670.1C401.3 647.4 440.4 622.5 477.9 595.5C515.5 568.5 551.6 539.5 585.9 508.6C595.5 499.9 603.6 492.4 611.6 484.9C620.5 476.6 629 468.7 637.4 461.3C646.2 453.5 655.1 446 664.5 439.3C673.7 432.6 683.6 426.4 694.3 421.2C704.7 416.1 715.6 412.1 727.1 409.3C740.3 406.1 753.8 404.7 767.4 405C780.9 405.3 794.4 407.5 807.4 411.3C820.4 415.1 832.8 420.7 844.4 427.8C855.9 434.9 866.5 443.4 875.8 453.3C885.2 463.1 893.1 474.2 899.6 486.1C904.5 495.1 908.4 504.5 911.5 514.3C914.6 524.2 916.7 534.2 918.2 544.2C919.7 554.2 920.6 564.3 921.1 574.6C921.6 584.3 921.8 594.4 921.9 605.3C922 613.1 922 621.8 922 635.9C922 640.7 922 645.5 922 650.3C922 673.1 922 687 921.9 699.3C921.7 715.7 921.5 730.6 920.7 744.4C920 758.2 918.8 771.2 916.9 783.6C915.1 795.1 912.7 805.9 909.4 816.1C906.1 826.1 902.2 835 897.6 843.3C895.1 847.8 892.3 852.2 889.3 856.4C886.3 860.6 883 864.7 879.5 868.5C876.1 872.4 872.4 876.1 868.5 879.5C864.7 883 860.6 886.3 856.4 889.3C852.2 892.3 847.8 895.1 843.3 897.6C835 902.2 826.1 906.1 816.1 909.4C805.9 912.7 795.1 915.1 783.6 916.9C771.2 918.8 758.2 920 744.4 920.7C730.6 921.5 715.7 921.7 699.3 921.9C687 922 673.1 922 650.3 922C558.1 922 465.8 922 373.6 922C350.8 922 336.9 922 324.6 921.9C308.2 921.7 293.3 921.5 279.5 920.7C265.7 920 252.7 918.8 240.4 916.9C228.8 915.1 218 912.7 207.8 909.4C197.8 906.1 188.9 902.2 180.6 897.6C176.1 895.1 171.7 892.3 167.5 889.3C163.3 886.3 159.2 883 155.4 879.5C151.5 876.1 147.8 872.4 144.4 868.5C140.9 864.7 137.6 860.6 134.6 856.4C131.6 852.2 128.8 847.8 126.3 843.3C121.7 835 117.8 826.1 114.5 816.1C111.2 805.9 108.8 795.1 107 783.6C106.7 782.1 106.5 780.6 106.3 779Z")

  static func path(svg: String) -> Path {
    var path = Path()
    var numbers: [CGFloat] = []
    var command: Character = "M"
    func flush() {
      switch command {
      case "M":
        path.move(to: CGPoint(x: numbers[0], y: numbers[1]))
      case "L":
        path.addLine(to: CGPoint(x: numbers[0], y: numbers[1]))
      case "C":
        path.addCurve(
          to: CGPoint(x: numbers[4], y: numbers[5]),
          control1: CGPoint(x: numbers[0], y: numbers[1]),
          control2: CGPoint(x: numbers[2], y: numbers[3])
        )
      default:
        break
      }
      numbers.removeAll()
    }
    let arity: [Character: Int] = ["M": 2, "L": 2, "C": 6]
    var token = ""
    func endNumber() {
      guard let value = Double(token) else { return }
      token = ""
      numbers.append(CGFloat(value))
      if numbers.count == arity[command] { flush() }
    }
    for character in svg {
      if character.isLetter {
        endNumber()
        command = character
        if character == "Z" { path.closeSubpath() }
      } else if character == " " {
        endNumber()
      } else {
        token.append(character)
      }
    }
    endNumber()
    return path
  }
}

public struct FidgetLogo: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var angle: Angle = .zero
  @State private var dragStart: Angle?
  @State private var lastSample: (angle: Angle, time: Date)?
  @State private var velocity: Double = 0
  @State private var spins = 0

  public init() {}

  public var body: some View {
    GeometryReader { proxy in
      let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
      ArdiaLogoMark(outlineWeight: 0.05)
        .shadow(color: .black.opacity(0.22), radius: 14, y: 6)
        .rotationEffect(angle)
        .frame(width: proxy.size.width, height: proxy.size.height)
        .contentShape(.circle)
        .gesture(spin(around: center))
    }
    .sensoryFeedback(.impact(weight: .light, intensity: 0.5), trigger: spins)
    .accessibilityElement()
    .accessibilityLabel("Ardia")
    .accessibilityAddTraits(.isImage)
  }

  private func spin(around center: CGPoint) -> some Gesture {
    DragGesture(minimumDistance: 2)
      .onChanged { value in
        let start = Self.bearing(of: value.startLocation, around: center)
        let now = Self.bearing(of: value.location, around: center)
        if dragStart == nil { dragStart = angle }
        var delta = now - start
        if delta.degrees > 180 { delta -= .degrees(360) }
        if delta.degrees < -180 { delta += .degrees(360) }
        let target = (dragStart ?? .zero) + delta
        let time = value.time
        if let lastSample {
          let elapsed = time.timeIntervalSince(lastSample.time)
          if elapsed > 0.004 { velocity = (target.degrees - lastSample.angle.degrees) / elapsed }
        }
        lastSample = (target, time)
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { angle = target }
      }
      .onEnded { _ in
        dragStart = nil
        lastSample = nil
        let clamped = max(-2400, min(2400, velocity))
        velocity = 0
        guard abs(clamped) > 60 else { return }
        if reduceMotion {
          withAnimation(.easeOut(duration: 0.3)) { angle = .zero }
          return
        }
        let travel = clamped * 0.42
        if abs(travel) >= 360 { spins += 1 }
        withAnimation(.timingCurve(0.12, 0.7, 0.25, 1, duration: Motion.logoSpinDecay)) {
          angle += .degrees(travel)
        }
      }
  }

  private static func bearing(of point: CGPoint, around center: CGPoint) -> Angle {
    .radians(atan2(point.y - center.y, point.x - center.x))
  }
}

#Preview("Logo") {
  VStack(spacing: 32) {
    ArdiaLogoMark().frame(width: 140)
    ArdiaLogoMark(outline: false).frame(width: 140)
    FidgetLogo().frame(width: 140, height: 120)
  }
  .padding(40)
  .background(ProfileBackdrop())
}
