import Foundation
import Testing

struct RangedSiteChoiceClears {
  let lastWeek = Date(timeIntervalSince1970: 1_800_000_000)
  let tenMinutesAgo = Date(timeIntervalSince1970: 1_800_600_000)
  let lastHour = Date(timeIntervalSince1970: 1_800_599_000)
  let camera = WebKitSiteChoices.Key(site: "https://meet.example", kind: "camera")
  let popups = WebKitSiteChoices.Key(site: "https://shop.example", kind: "popups")
  let zoomLink = WebKitSiteChoices.Key(site: "https://meet.example", kind: "zoommtg")
  let mailLink = WebKitSiteChoices.Key(site: "https://mail.example", kind: "mailto")

  func grant(_ key: WebKitSiteChoices.Key) -> WebKitSiteChoices.ExternalGrant {
    WebKitSiteChoices.ExternalGrant(origin: key.site, scheme: key.kind, app: "App", appPath: "/Applications/App.app")
  }

  func profileWithOldAndNewChoices() -> WebKitSiteChoices {
    var state = WebKitSiteChoices()
    state.remember(camera, allowed: true, at: lastWeek)
    state.allowExternal(zoomLink, grant(zoomLink), at: lastWeek)
    state.remember(popups, allowed: false, at: tenMinutesAgo)
    state.allowExternal(mailLink, grant(mailLink), at: tenMinutesAgo)
    state.zoom["meet.example"] = 1.25
    return state
  }

  @Test func `clearing the last hour keeps older permissions and external-app allowances`() {
    var state = profileWithOldAndNewChoices()
    state.forgetSiteChoices(since: lastHour)
    #expect(state.remembered == [camera: true])
    #expect(Set(state.externalAllowances.keys) == [zoomLink])
    #expect(state.zoom["meet.example"] == 1.25)
  }

  @Test func `clearing all time forgets every permission and external-app allowance`() {
    var state = profileWithOldAndNewChoices()
    state.forgetSiteChoices(since: nil)
    #expect(state.remembered.isEmpty)
    #expect(state.externalAllowances.isEmpty)
    #expect(state.zoom["meet.example"] == 1.25)
  }

  @Test func `changing an old choice inside the range makes it part of the range`() {
    var state = profileWithOldAndNewChoices()
    state.remember(camera, allowed: false, at: tenMinutesAgo)
    state.forgetSiteChoices(since: lastHour)
    #expect(state.remembered[camera] == nil)
  }

  @Test func `a forgotten choice set again later is timed from the new choice`() {
    var state = WebKitSiteChoices()
    state.remember(camera, allowed: true, at: tenMinutesAgo)
    state.forgetAnswer(camera)
    state.remember(camera, allowed: true, at: lastWeek)
    state.removeExternal(mailLink)
    state.forgetSiteChoices(since: lastHour)
    #expect(state.remembered == [camera: true])
  }

  @Test(arguments: [0.0, -1.0, .infinity, .nan])
  func `a missing or unusable since means all time`(since: Double) {
    #expect(WebKitSiteChoices.rangeStart(sinceMilliseconds: since) == nil)
  }

  @Test func `since is read as milliseconds since 1970`() {
    #expect(WebKitSiteChoices.rangeStart(sinceMilliseconds: 1_800_599_000_000) == lastHour)
  }
}
