import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct PageSummaryOutlineTests {
  @Test func readsTheLeadAndLabelledRows() {
    let outline = PageSummaryOutline("""
      = Octopuses pump blue blood with three hearts.
      - heart.fill | Two Gill Hearts | Each pushes blood through one gill.
      - drop.fill | Blue Blood | Hemocyanin carries less oxygen.
      """)
    #expect(outline.lead == "Octopuses pump blue blood with three hearts.")
    #expect(outline.rows == [
      .init(id: 0, symbol: "heart.fill", label: "Two Gill Hearts", info: "Each pushes blood through one gill."),
      .init(id: 1, symbol: "drop.fill", label: "Blue Blood", info: "Hemocyanin carries less oxygen."),
    ])
  }

  @Test func keyLinesBecomeALeadAndPlainRows() {
    let outline = PageSummaryOutline("- First line of the page.\n- Second line.\n- Third line.")
    #expect(outline.lead == "First line of the page.")
    #expect(outline.rows.map(\.info) == ["Second line.", "Third line."])
    #expect(outline.rows.map(\.id) == [0, 1])
    #expect(outline.rows.allSatisfy { $0.symbol == nil && $0.label == nil })
  }

  @Test func aSingleKeyLineIsTheLead() {
    let outline = PageSummaryOutline("- Only line.")
    #expect(outline.lead == "Only line.")
    #expect(outline.rows.isEmpty)
  }

  @Test func looseLinesBecomeRowsOfTheirOwn() {
    let outline = PageSummaryOutline("= Lead.\nA line with no mark.\n- star | Label | Detail.\nAnother loose line.\n= A second lead.")
    #expect(outline.lead == "Lead.")
    #expect(outline.rows.map(\.info) == ["A line with no mark.", "Detail.", "Another loose line.", "A second lead."])
    #expect(outline.rows.map(\.id) == [0, 1, 2, 3])
  }

  func staysAsShown(_ whole: String) {
    let final = PageSummaryOutline(whole, finished: true)
    var shown = PageSummaryOutline()
    for end in whole.indices {
      let next = PageSummaryOutline(String(whole[...end]), finished: false)
      #expect(shown.lead == nil || next.lead == shown.lead)
      #expect(Array(next.rows.prefix(shown.rows.count)) == shown.rows)
      #expect(next.lead == nil || next.lead == final.lead)
      #expect(Array(final.rows.prefix(next.rows.count)) == next.rows)
      shown = next
    }
  }

  @Test func whatIsShownWhileWritingNeverChanges() {
    staysAsShown("= Lead sentence.\n- heart.fill | Two Gill Hearts | Each pushes blood.\n- drop.fill | Blue Blood | Copper based.")
    staysAsShown("= Lead sentence. - heart.fill | Two Gill Hearts | Each pushes blood. - drop.fill | Blue Blood | Copper based.")
    staysAsShown("= Lead sentence. heart.fill | Two Gill Hearts | Each pushes blood.")
    staysAsShown("- First.\n- Second.\n- Third.\n")
    staysAsShown("= First.\nContinuation.\n- star | A detail.\nMore.\n")
    staysAsShown("- star | Detail one.\n- Second.\n= Late lead.\n")
    staysAsShown("Plain opening.\nPlain second.\n- Label only | The detail.")
    staysAsShown("= Prices rose 4% | 5% in May.\n- clock | When | In May | and June.")
    staysAsShown("= Lead. - star | AA | clock | BB | Detail.\n")
    staysAsShown("= Lead. - star | First Label | One. - clock | Second Label | Two.\n- leaf | Third | Three with a bar | inside.\n")
  }

  @Test func splittingRunTogetherRowsTwiceChangesNothing() {
    for text in ["= Lead. - star | AA | clock | BB | Detail.", "= Lead. - heart.fill | Two Hearts | Each pushes. • drop.fill | Blue Blood | Copper.", "- leaf | Third | Three with a word | inside | bars."] {
      let once = PageSummaryOutline.unrun(text)
      #expect(PageSummaryOutline.unrun(once) == once)
      #expect(PageSummaryOutline(once) == PageSummaryOutline(text))
    }
  }

  @Test func partialRowsKeepWhatTheyHave() {
    let outline = PageSummaryOutline("= Lead.\n- Label only | The detail.\n- star | The other detail.\n- bad symbol! | Label | Detail | with a bar.")
    #expect(outline.rows[0] == .init(id: 0, label: "Label only", info: "The detail."))
    #expect(outline.rows[1] == .init(id: 1, symbol: "star", info: "The other detail."))
    #expect(outline.rows[2] == .init(id: 2, label: "Label", info: "Detail | with a bar."))
  }

  @Test func aLineStillBeingWrittenIsShownAsItIs() {
    let outline = PageSummaryOutline("= Lead [1].\n- heart.fill | Two Gill")
    #expect(outline.lead == "Lead.")
    #expect(outline.rows == [.init(id: 0, symbol: "heart.fill", info: "Two Gill")])
  }

  @Test func whileWritingOnlyWholeLinesShow() {
    let whole = "= Lead sentence.\n- heart.fill | Two Gill Hearts | Each pushes blood.\n- drop.fill | Blue"
    #expect(PageSummaryOutline(whole, finished: false).rows.map(\.label) == ["Two Gill Hearts"])
    #expect(PageSummaryOutline(whole, finished: true).rows.count == 2)
    #expect(PageSummaryOutline("= Lead still being wr", finished: false).isEmpty)
    #expect(PageSummaryOutline.wholeLines("= Lead.\n- star | Half") == "= Lead.")
  }

  @Test func rowsRunTogetherOnOneLineAreSeparated() {
    let outline = PageSummaryOutline("= Three hearts help octopuses. The system balances pressure. - heart.fill | Branchial Hearts | Each heart sits at a gill. - drop.fill | Blood Type | Hemocyanin is copper-based.\n- clock | Later | It tires fast.")
    #expect(outline.lead == "Three hearts help octopuses. The system balances pressure.")
    #expect(outline.rows.map(\.symbol) == ["heart.fill", "drop.fill", "clock"])
    #expect(outline.rows.map(\.label) == ["Branchial Hearts", "Blood Type", "Later"])
    #expect(outline.rows[0].info == "Each heart sits at a gill.")
    #expect(PageSummaryOutline("= Prices rose 4% | 5% in May.").lead == "Prices rose 4% | 5% in May.")
  }

  @Test func barsInALeadStayInTheLead() {
    let whole = "= Compare tiers: basic | pro | enterprise.\n- star | Plans | Three of them."
    let final = PageSummaryOutline(whole)
    #expect(final.lead == "Compare tiers: basic | pro | enterprise.")
    #expect(final.rows == [.init(id: 0, symbol: "star", label: "Plans", info: "Three of them.")])
    #expect(PageSummaryOutline("= Compare tiers: basic | pro |", finished: false).isEmpty)
    #expect(PageSummaryOutline("= Compare tiers. basic | pro | enterprise.").lead == "Compare tiers. basic | pro | enterprise.")
    #expect(PageSummaryOutline("= Compare tiers. basic | Pro | Enterprise.").lead == "Compare tiers. basic | Pro | Enterprise.")
    #expect(PageSummaryOutline("= Pressure. heart.fill | Hearts | Each one.").lead == "Pressure. heart.fill | Hearts | Each one.")
    staysAsShown(whole)
  }

  @Test func aRunOnRowSplitsOnlyAtABulletAfterASentenceEnds() {
    #expect(PageSummaryOutline("= Lead [2]. - star | Label | Detail.").lead == "Lead.")
    #expect(PageSummaryOutline("= Lead. • star | Label | Detail.").rows == [.init(id: 0, symbol: "star", label: "Label", info: "Detail.")])
    #expect(PageSummaryOutline("= Plans: - star | Label | Detail.").lead == "Plans: - star | Label | Detail.")
    #expect(PageSummaryOutline("= Lead. star | Label | Detail.").lead == "Lead. star | Label | Detail.")
    #expect(PageSummaryOutline("= Lead. - star | Label |", finished: false).lead == "Lead.")
    #expect(PageSummaryOutline("= Lead. star | Label |", finished: false).isEmpty)
  }

  @Test func excerptsKeepTheirBarsAsWritten() {
    let text = "- Basic | Pro | Enterprise are the three plans offered by this service.\n- Each | plan | bills monthly [3].\n- star | Label | Detail."
    let outline = PageSummaryOutline(text, finished: true, format: .excerpts)
    #expect(outline.lead == "Basic | Pro | Enterprise are the three plans offered by this service.")
    #expect(outline.rows == [.init(id: 0, info: "Each | plan | bills monthly."), .init(id: 1, info: "star | Label | Detail.")])
    #expect(PageSummaryOutline(text, finished: false, format: .excerpts) == outline)
    #expect(PageSummaryOutline(excerpts: " \n- \n").isEmpty)
  }

  @Test func emptyTextIsEmpty() {
    #expect(PageSummaryOutline("").isEmpty)
    #expect(PageSummaryOutline(" \n=\n- \n").isEmpty)
  }
}
