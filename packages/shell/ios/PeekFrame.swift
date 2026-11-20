import CoreGraphics

struct PeekFrame {
  var card = PeekAffine.identity
  var page = PeekAffine.identity
  var cardAlpha = 0.0
  var chromeAlpha = 1.0
  var scrimAlpha = 0.0
  var topRadius = 0.0
  var bottomRadius = 0.0
  var from: [CGPoint] = []
  var to: [CGPoint] = []
  var residual = 0.0

  var warping: Bool { !to.isEmpty }

  var shownPage: CGRect = .zero
}
