import ActivityKit
import Foundation
import Testing

@testable import Terminus

/// The system side, on the API's golden answers: the Live Activity's state,
/// the leave reminders, the widgets' words and timing, and the links a
/// widget opens.

private func answer(_ name: String) throws -> (NextAnswer, Date) {
    let data = try Data(contentsOf: fixtures.appendingPathComponent("answers/\(name).json"))
    let a = try NextAnswer.decode(data)
    let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let asOf = try #require((raw["asOf"] as? String).flatMap(parseISODate))
    return (a, asOf)
}

// MARK: the Live Activity

@Test func noLiveActivityBeforeTheTripStarts() throws {
    let (a, _) = try answer("class-bus")
    #expect(a.phase == "idle")
    #expect(TripAttributes.ContentState.of(a) == nil)
}

/// Between the server's pushes the app updates the activity from each answer
/// it fetches: any field the two build differently flips back and forth on
/// the Lock Screen. fixtures/live-activity.json is the server's state for
/// every golden answer under way (written by apns.test.js).
@Test func theStateIsTheServersForEveryAnswer() throws {
    let server = try JSONDecoder().decode(
        [String: TripAttributes.ContentState].self, from: Data(contentsOf: fixtures.appendingPathComponent("live-activity.json")))
    #expect(server.count >= 10)
    for (name, want) in server.sorted(by: { $0.key < $1.key }) {
        let (a, _) = try answer(name)
        #expect(TripAttributes.ContentState.of(a) == want, "\(name)")
    }
}

/// A stale activity (the phone offline a few minutes) is still the trip's:
/// updated, not ended and left unstarted in the background.
@Test func aStaleActivityIsUpdatedNotEnded() {
    #expect(LiveTrip.onScreen(.active))
    #expect(LiveTrip.onScreen(.stale))
    #expect(!LiveTrip.onScreen(.ended))
    #expect(!LiveTrip.onScreen(.dismissed))
}

@Test func onTheBusCountsDownToGettingOff() throws {
    let (a, now) = try answer("riding")
    let s = try #require(TripAttributes.ContentState.of(a))
    #expect(s.phase == "riding")
    #expect(s.svc == a.card?.ride?.svc)
    #expect(s.off == a.card?.ride?.stops.last?.name)
    let arrive = try #require(s.arriveDate)
    let count = try #require(s.countdown(now: now))
    #expect(count.kind == "off")
    #expect(count.to == arrive)
    #expect(s.countdown(now: arrive.addingTimeInterval(1)) == nil)
}

@Test func missedCountsDownToNothingOfItsOwn() throws {
    let (a, now) = try answer("missed")
    let s = try #require(TripAttributes.ContentState.of(a))
    #expect(s.phase == "missed")
    #expect(s.headline == a.card?.title)
    #expect(s.line == a.card?.line)
    #expect(s.countdown(now: now) == nil)
}

@Test func theBusGoneCountsToTheNextBusNotToLeaving() throws {
    let (a, now) = try answer("bus-gone")
    let s = try #require(TripAttributes.ContentState.of(a))
    if let count = s.countdown(now: now) { #expect(count.kind == "bus") }
}

/// The server pushes the same state: the keys must be exactly its, times in whole epoch seconds.
@Test func theStateEncodesWithTheServersKeys() throws {
    let (a, _) = try answer("riding")
    let s = try #require(TripAttributes.ContentState.of(a))
    let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any])
    let allowed: Set<String> = [
        "phase", "phaseText", "headline", "line", "glance", "to", "svc", "color", "stop", "off",
        "leaveAt", "departAt", "arriveAt", "estimated", "gone", "late", "staleAt",
    ]
    #expect(Set(json.keys).isSubset(of: allowed))
    #expect(json["arriveAt"] is Int)
    // And the server's own, with nulls, decodes.
    let pushed =
        ##"{"phase":"due","phaseText":"Time to go","headline":"Leave now","line":"R2 09:42 at PGP","glance":"R2 09:42","to":null,"svc":"R2","color":"#34a853","stop":"PGP","off":null,"leaveAt":1788000000,"departAt":1788000300,"arriveAt":null,"estimated":false,"gone":false,"late":false,"staleAt":1788000400}"##
    let back = try JSONDecoder().decode(TripAttributes.ContentState.self, from: Data(pushed.utf8))
    #expect(back.countdown(now: Date(timeIntervalSince1970: 1_787_999_000))?.kind == "leave")
    #expect(back.countdown(now: Date(timeIntervalSince1970: 1_788_000_100))?.kind == "bus")
}

// MARK: the leave reminders

@Test func aClassTripSchedulesTheHeadsUpAndLeaveNow() throws {
    let (a, now) = try answer("class-bus")
    let remindAt = try #require(a.card?.remindAt.flatMap(parseISODate))
    let leaveAt = try #require(a.leaveAt)
    let step = TripReminders.step(a, soonTrip: nil, soonAt: nil, now: now)
    #expect(step == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: remindAt, leaveAt: leaveAt))
    // Once the heads-up has gone for this trip, it doesn't come back.
    let key = try #require(TripReminders.soonKey(a, now: now))
    let again = TripReminders.step(a, soonTrip: key, soonAt: now.addingTimeInterval(-60), now: now)
    #expect(again == .schedule(clearFirst: false, trip: "4:600:UTOWN", soon: nil, leaveAt: leaveAt))
    // The same class a week before was another trip: its heads-up doesn't stop this week's.
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .campus
    let week = cal.dateComponents([.year, .month, .day], from: leaveAt.addingTimeInterval(-7 * 86_400))
    let lastWeek = "4:600:UTOWN@\(week.year!)-\(week.month!)-\(week.day!)"
    #expect(key != lastWeek && key.hasPrefix("4:600:UTOWN@"))
    let nextWeek = TripReminders.step(a, soonTrip: lastWeek, soonAt: now.addingTimeInterval(-7 * 86_400), now: now)
    #expect(nextWeek == .schedule(clearFirst: true, trip: "4:600:UTOWN", soon: remindAt, leaveAt: leaveAt))
    // Another trip's are cleared first.
    let other = TripReminders.step(a, soonTrip: "4:500:COM3", soonAt: nil, now: now)
    #expect(other == .schedule(clearFirst: true, trip: "4:600:UTOWN", soon: remindAt, leaveAt: leaveAt))
    // Its heads-up swiped away: no "Leave now" either, and nothing comes back; another trip's still does.
    #expect(TripReminders.step(a, soonTrip: key, soonAt: now.addingTimeInterval(-60), dismissed: key, now: now) == .clear)
    #expect(TripReminders.step(a, soonTrip: key, soonAt: nil, dismissed: lastWeek, now: now) != .clear)
    // Past the leave-by, nothing to schedule.
    #expect(TripReminders.step(a, soonTrip: nil, soonAt: nil, now: leaveAt.addingTimeInterval(1)) == .clear)
}

@Test func onTheWayOrOnTheBusTheRemindersGo() throws {
    let (riding, now) = try answer("riding")
    #expect(TripReminders.step(riding, soonTrip: nil, soonAt: nil, now: now) == .over)
    let (missed, then) = try answer("missed")
    #expect(TripReminders.step(missed, soonTrip: nil, soonAt: nil, now: then) == .over)
    let (gone, at) = try answer("bus-gone")
    let step = TripReminders.step(gone, soonTrip: nil, soonAt: nil, now: at)
    #expect(step == (gone.card?.gone == true ? .over : .heading))
}

@Test func theRemindersWordsAreTheServers() throws {
    let (a, now) = try answer("class-bus")
    let w = TripReminders.words(a, leaveNow: false, firesAt: now, checked: now)
    #expect(w.title == a.card?.leaveBy)
    #expect(!w.body.isEmpty)
    #expect(!w.body.contains("Last checked"))
    let late = TripReminders.words(a, leaveNow: true, firesAt: try #require(a.staleAt), checked: now)
    #expect(late.title == "Leave now")
    #expect(late.body.contains("Last checked"))
}

// MARK: the widgets

@Test func signedOutTheWidgetSaysSo() {
    let f = WidgetFace.of(paired: false, mode: .timetable, answer: nil, error: nil, offline: nil, now: Date())
    #expect(f.headline == "terminus")
    #expect(f.sub == "Open terminus to sign in")
}

@Test func aClassTripLeadsWithWhenToLeave() throws {
    let (a, now) = try answer("class-bus")
    let f = WidgetFace.of(paired: true, mode: .timetable, answer: a, error: nil, offline: nil, now: now)
    #expect(f.headline == a.card?.leaveBy)
    #expect(f.leg?.svc == "R2")
    // When to leave is in the headline: no countdown under it, as on Android, where "17:44" could be read as a time.
    #expect(f.sub == a.card?.journey.flatMap { JourneyText.arrive($0) })
}

@Test func onTheBusTheWidgetSaysWhereToGetOff() throws {
    let (a, now) = try answer("riding")
    let f = WidgetFace.of(paired: true, mode: .timetable, answer: a, error: nil, offline: nil, now: now)
    let off = try #require(a.card?.ride?.stops.last?.name)
    #expect(f.headline.hasPrefix("Off at \(off)"))
}

@Test func theWidgetsAskAgainAtTheServersMomentNotSooner() throws {
    let (a, now) = try answer("class-bus")
    let next = WidgetTiming.nextRefreshAt(a, fetchedAt: now, now: now)
    #expect(next >= now.addingTimeInterval(WidgetTiming.minGap))
    if let server = WidgetTiming.serverRefreshAt(a, now: now) { #expect(next == server) }
    #expect(WidgetTiming.due(nil, fetchedAt: nil, now: now))
    #expect(!WidgetTiming.due(a, fetchedAt: now, now: now))
    // Redrawn when "Leave by" turns into "Leave now".
    let leaveAt = try #require(a.leaveAt)
    #expect(WidgetTiming.redraws(a, now: now, until: now.addingTimeInterval(3600)).contains(leaveAt))
}

@Test func aChosenPlaceLastsHalfAnHour() throws {
    let (a, now) = try answer("class-bus")
    let place = WidgetMode.to(id: "stop:COM3", label: "COM3")
    #expect(WidgetMode.effective(place, at: now, plan: a, rowShown: true, now: now) == place)
    #expect(WidgetMode.effective(place, at: now, plan: a, rowShown: true, now: now.addingTimeInterval(WidgetMode.keep + 1)) == .timetable)
    #expect(WidgetMode.effective(place, at: now, plan: a, rowShown: false, now: now) == .timetable)
}

/// The background refresh with the phone ten minutes fast: the kept answer
/// came a day after its moments, so it's asked again the fallback's 15
/// minutes after it came by the phone's clock, not 25.
@Test func theBackgroundRefreshReadsBothClocksTheSameWay() throws {
    let (a, asOf) = try answer("riding")
    let fetched = asOf.addingTimeInterval(86_400)
    #expect(Background.refreshAt((a, fetched), now: fetched, skew: -600) == fetched.addingTimeInterval(15 * 60))
}

// MARK: the keychain

/// Before the first unlock after a restart the keychain answers nothing:
/// that isn't signed out, and a widget asks again in five minutes rather
/// than never.
@Test func aLockedKeychainIsNotSignedOut() {
    #expect(TokenStore.lookupAnswer(errSecInteractionNotAllowed, data: nil) == .locked)
    #expect(TokenStore.lookupAnswer(errSecItemNotFound, data: nil) == .none)
    #expect(TokenStore.lookupAnswer(errSecSuccess, data: Data("t".utf8)) == .found("t"))
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(WidgetTiming.signedOutReload(locked: true, now: now) == now.addingTimeInterval(300))
    #expect(WidgetTiming.signedOutReload(locked: false, now: now) == nil)
}

// MARK: links

@Test func widgetLinksOpenTheRightPlace() {
    let key = "k1"
    #expect(Links.route(URL(string: "terminus://plan")!, key: key) == .plan)
    #expect(Links.route(URL(string: "terminus://nearby")!, key: key) == .nearby)
    #expect(Links.route(URL(string: "terminus://place/home")!, key: key) == .place("home"))
    #expect(Links.route(URL(string: "terminus://to/COM3?label=COM3&k=k1")!, key: key) == .to("COM3", "COM3"))
    #expect(Links.route(URL(string: "terminus://buses")!, key: key) == .tab(.buses))
    // Only this phone's own widgets can add a stop, and only with a short name.
    #expect(Links.route(URL(string: "terminus://to/COM3?label=COM3&k=other")!, key: key) == nil)
    let long = String(repeating: "x", count: 200)
    #expect(
        Links.route(URL(string: "terminus://to/COM3?label=\(long)&k=k1")!, key: key)
            == .to("COM3", String(repeating: "x", count: Links.maxLabel)))
    #expect(Links.route(URL(string: "terminus://elsewhere")!, key: key) == nil)
}

@Test func theWidgetsOwnLinksRoundTrip() {
    let mode = WidgetMode.to(id: "stop:COM3", label: "COM 3")
    #expect(Links.route(mode.link, key: WidgetStore.linkKey) == .to("COM3", "COM 3"))
    #expect(Links.route(WidgetMode.nearby.link, key: WidgetStore.linkKey) == .nearby)
}

// MARK: push

@Test func pushTokensAreHexWithTheirKind() {
    let t = Api.apnsToken(Data([0x0a, 0xff, 0x00]))
    let la = Api.apnsToken(Data([0x01]), prefix: "apnsla")
    let start = Api.apnsToken(Data([0x02]), prefix: "apnsstart")
    let tail = Api.apnsSandbox ? ":sandbox" : ""
    #expect(t == "apns:0aff00" + tail)
    #expect(la == "apnsla:01" + tail)
    #expect(start == "apnsstart:02" + tail)
}

/// Turn off on the Live Activity turns the setting off, as Android's does, and leaves the leave alerts as they were.
@MainActor @Test func turnOffOnTheLiveActivityTurnsItOff() async throws {
    let (live, alerts) = (TripPrefs.liveActivity, TripPrefs.leaveAlerts)
    defer { (TripPrefs.liveActivity, TripPrefs.leaveAlerts) = (live, alerts) }
    TripPrefs.liveActivity = true
    TripPrefs.leaveAlerts = true
    _ = try await TurnOffLiveIntent().perform()
    #expect(!TripPrefs.liveActivity)
    #expect(TripPrefs.leaveAlerts)
}

@Test func aSavedPlacesLinkOpensItsTab() {
    #expect(Links.route(WidgetMode.to(id: "place:home", label: "Home").link, key: "") == .place("home"))
}
