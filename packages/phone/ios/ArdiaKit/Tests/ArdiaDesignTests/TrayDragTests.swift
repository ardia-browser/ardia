import ArdiaDesign
import CoreGraphics
import Testing

struct TrayDragTests {
  @Test func `downward drags follow the finger exactly`() {
    #expect(TrayDrag.offset(for: 0) == 0)
    #expect(TrayDrag.offset(for: 84) == 84)
  }

  @Test func `upward drags resist and never pass the limit`() {
    let small = TrayDrag.offset(for: -10)
    let large = TrayDrag.offset(for: -400)
    #expect(small < 0 && small > -10)
    #expect(large < small)
    #expect(large > -TrayDrag.upwardLimit)
  }

  @Test func `a slow short drag springs back`() {
    #expect(!TrayDrag.shouldDismiss(translation: 40, velocity: 60, trayHeight: 274))
  }

  @Test func `a slow drag past about a third of the tray dismisses`() {
    #expect(!TrayDrag.shouldDismiss(translation: 90, velocity: 0, trayHeight: 274))
    #expect(TrayDrag.shouldDismiss(translation: 100, velocity: 0, trayHeight: 274))
  }

  @Test func `a flick down dismisses from a short distance`() {
    #expect(TrayDrag.shouldDismiss(translation: 14, velocity: 1200, trayHeight: 274))
  }

  @Test func `moving back up cancels even past the distance`() {
    #expect(!TrayDrag.shouldDismiss(translation: 200, velocity: -600, trayHeight: 274))
  }

  @Test func `an upward pull never dismisses`() {
    #expect(!TrayDrag.shouldDismiss(translation: -20, velocity: 1500, trayHeight: 274))
  }

  @Test func `a compact tray needs a proportionally shorter drag`() {
    #expect(TrayDrag.shouldDismiss(translation: 40, velocity: 0, trayHeight: 78))
    #expect(!TrayDrag.shouldDismiss(translation: 40, velocity: 0, trayHeight: 274))
  }

  @Test func `a very tall tray still dismisses from a capped distance`() {
    #expect(!TrayDrag.shouldDismiss(translation: 110, velocity: 0, trayHeight: 2000))
    #expect(TrayDrag.shouldDismiss(translation: 125, velocity: 0, trayHeight: 2000))
  }

  @Test func `the keyboard waits for a deliberate pull`() {
    #expect(!TrayDrag.releasesKeyboard(translation: 3))
    #expect(!TrayDrag.releasesKeyboard(translation: -30))
    #expect(TrayDrag.releasesKeyboard(translation: 20))
  }

  @Test func `a grabbed offset maps back to the drag that made it`() {
    for translation: CGFloat in [-120, -40, -5, 0, 30, 200] {
      #expect(abs(TrayDrag.translation(for: TrayDrag.offset(for: translation)) - translation) < 0.001)
    }
  }

  @Test func `a downward release hands the tray the finger's speed`() {
    #expect(TrayDrag.trayVelocity(translation: 80, fingerVelocity: 900) == 900)
  }

  @Test func `an upward release hands over the damped speed the tray actually had`() {
    let step: CGFloat = 0.01
    let translation: CGFloat = -50
    let measured = (TrayDrag.offset(for: translation + step) - TrayDrag.offset(for: translation)) / step
    #expect(abs(TrayDrag.trayVelocity(translation: translation, fingerVelocity: 1) - measured) < 0.001)
  }

  @Test func `progress is clamped to the travel`() {
    #expect(TrayDrag.progress(offset: -10, travel: 300) == 0)
    #expect(TrayDrag.progress(offset: 150, travel: 300) == 0.5)
    #expect(TrayDrag.progress(offset: 900, travel: 300) == 1)
    #expect(TrayDrag.progress(offset: 50, travel: 0) == 0)
  }
}
