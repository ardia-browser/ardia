import SwiftUI

public struct ProfileBackdrop: View {
  private let look: ProfileLook?
  private let themeLook: ThemeLook?
  private let themed: Bool
  private let softened: Bool
  private let fadesOut: Bool

  @Environment(\.colorScheme) private var colorScheme
  @Environment(\.profileLook) private var ambientLook

  public static let themeVeil = 0.34

  public init(look: ProfileLook? = nil, themeLook: ThemeLook? = nil, themed: Bool = false, softened: Bool = false, fadesOut: Bool = false) {
    self.look = look
    self.themeLook = themeLook
    self.themed = themed
    self.softened = softened
    self.fadesOut = fadesOut
  }

  public var body: some View {
    if fadesOut {
      ZStack {
        #if canImport(UIKit)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
        backdrop(softened: true)
          .mask {
            LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black.opacity(0.6), location: 0.45), .init(color: .clear, location: 0.8)], startPoint: .top, endPoint: .bottom)
          }
      }
    } else {
      backdrop(softened: softened)
    }
  }

  @ViewBuilder
  private func backdrop(softened: Bool) -> some View {
    if themed, let themeLook {
      ThemeBackdrop(look: themeLook, dark: colorScheme == .dark)
        .overlay {
          if softened {
            Color.adaptive(light: .white.opacity(0.72), dark: .black.opacity(0.55))
          }
        }
    } else {
      gradientBackdrop(softened: softened)
    }
  }

  @ViewBuilder
  private func gradientBackdrop(softened: Bool) -> some View {
    let look = look ?? ambientLook
    let dark = colorScheme == .dark
    let showsTheme = look.showsTheme(dark: dark, themed: themed)
    LinearGradient(
      colors: look.backdropColors(dark: dark, themed: themed),
      startPoint: showsTheme ? .topLeading : .top,
      endPoint: showsTheme ? .bottomTrailing : .bottom
    )
    .overlay {
      if showsTheme && !dark {
        Color.white.opacity(ProfileBackdrop.themeVeil)
      }
    }
    .overlay {
      if softened {
        Color.adaptive(light: .white.opacity(0.72), dark: .black.opacity(0.55))
      }
    }
    .overlay { FilmGrain(opacity: dark ? 0.03 : 0.06) }
    .accessibilityHidden(true)
  }
}

public struct LookFrost: View {
  public enum Variant: String, Sendable {
    case bar
    case sheet
    case glass
    case thin
  }

  private let variant: Variant
  private let look: ProfileLook
  private let cornerRadius: Double
  private let reduceTransparencyOverride: Bool?

  @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency

  public init(variant: Variant, look: ProfileLook, cornerRadius: Double = 0, reduceTransparency: Bool? = nil) {
    self.variant = variant
    self.look = look
    self.cornerRadius = cornerRadius
    reduceTransparencyOverride = reduceTransparency
  }

  public var body: some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    let solid = reduceTransparencyOverride ?? systemReduceTransparency
    ZStack {
      if look == .incognito, variant == .sheet || variant == .bar {
        shape.fill(BrowsePalette.incognitoSheet)
      } else if solid {
        shape.fill(look.surface)
      } else {
        switch variant {
        case .bar:
          shape.fill(.bar)
          shape.fill(look.surface.opacity(profileSheetTintShare))
        case .sheet:
          shape.fill(.regularMaterial)
          shape.fill(look.surface.opacity(profileSheetTintShare))
        case .glass:
          Color.clear.glassEffect(.regular, in: shape)
        case .thin:
          shape.fill(.ultraThinMaterial)
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

public struct FilmGrain: View {
  public var opacity: Double

  public init(opacity: Double = 0.16) {
    self.opacity = opacity
  }

  public var body: some View {
    Image(decorative: GrainTexture.image, scale: 2)
      .resizable(resizingMode: .tile)
      .blendMode(.overlay)
      .opacity(opacity)
      .allowsHitTesting(false)
      .accessibilityHidden(true)
  }
}

enum GrainTexture {
  static let side = 128

  static let image: CGImage = {
    var state: UInt32 = 0x9E37_79B9
    var bytes = [UInt8](repeating: 0, count: side * side * 4)
    for index in 0..<(side * side) {
      state ^= state << 13
      state ^= state >> 17
      state ^= state << 5
      let value = UInt8(truncatingIfNeeded: 64 + Int(state % 128))
      bytes[index * 4] = value
      bytes[index * 4 + 1] = value
      bytes[index * 4 + 2] = value
      bytes[index * 4 + 3] = 255
    }
    let provider = CGDataProvider(data: Data(bytes) as CFData)!
    return CGImage(
      width: side,
      height: side,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: side * 4,
      space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    )!
  }()
}

public extension Color {
  init?(hexString: String) {
    var text = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.hasPrefix("#") { text.removeFirst() }
    guard text.count == 6, let value = UInt32(text, radix: 16) else { return nil }
    self.init(hex: value)
  }
}

#Preview("Backdrop") {
  ProfileBackdrop().ignoresSafeArea()
}

#Preview("Softened") {
  ProfileBackdrop(softened: true).ignoresSafeArea()
}

private let profileSheetTintShare: Double = 0.8
