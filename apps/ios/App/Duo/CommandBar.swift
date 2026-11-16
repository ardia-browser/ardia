import ArdiaDesign
import SwiftUI

struct CommandBarPlacement: Equatable {
  let top: CGFloat
  let maxHeight: CGFloat

  init(proxy: GeometryProxy, lift: CGFloat) {
    let safeTop = proxy.safeAreaInsets.top
    top = DuoLayout.cardTop(safeTop: safeTop) + DuoLayout.commandTop - safeTop
    let keyboardTop = proxy.size.height + proxy.safeAreaInsets.bottom - lift
    maxHeight = max(min(DuoLayout.commandMaxHeight, keyboardTop - top - DuoLayout.commandAboveKeyboard), 0)
  }
}
