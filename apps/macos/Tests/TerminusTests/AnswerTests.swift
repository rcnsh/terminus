import Foundation
import Testing
@testable import Terminus

/// The API's golden answers, checked by its own tests: a change in the
/// response shape fails here too.
private func golden(_ name: String) throws -> NextAnswer {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    let data = try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    return try JSONDecoder().decode(NextAnswer.self, from: data)
}

/// Every golden there is, English and Chinese ("zh/free"), found in the
/// directory: a new one is read without being listed here.
func goldenNames() -> [String] {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    let names = { (sub: String) in
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent(sub).path)) ?? [])
            .filter { $0.hasSuffix(".json") }
            .map { (sub.isEmpty ? "" : "\(sub)/") + String($0.dropLast(5)) }
    }
    return (names("") + names("zh")).sorted()
}

@Test func theGoldensAreFound() {
    #expect(goldenNames().count >= 40)
}

/// By the endpoint each answers: /me/nearby has `stops`, /me/day `items`,
/// the rest are /me/next with a card. The card's parts are read leniently,
/// so one that no longer decodes would just vanish: each one sent must
/// come through.
@Test(arguments: goldenNames())
func everyGoldenAnswerDecodes(name: String) throws {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    let data = try Data(contentsOf: dir.appendingPathComponent("\(name).json"))
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    if json["stops"] != nil {
        struct R: Decodable { let stops: [NearbyStop] }
        #expect(try !JSONDecoder().decode(R.self, from: data).stops.isEmpty)
        return
    }
    if json["items"] != nil {
        #expect(try !JSONDecoder().decode(DayPlan.self, from: data).items.isEmpty)
        return
    }
    let a = try JSONDecoder().decode(NextAnswer.self, from: data)
    let card = try #require(a.card, "\(name) has a card")
    let sent = try #require(json["card"] as? [String: Any])
    let present = { (key: String) in sent[key] != nil && !(sent[key] is NSNull) }
    if present("journey") { #expect(card.journey != nil, "card.journey") }
    if present("ride") { #expect(card.ride != nil, "card.ride") }
    if present("upcoming") { #expect(card.upcoming != nil, "card.upcoming") }
    if present("suggestion") { #expect(card.suggestion != nil, "card.suggestion") }
    #expect(card.actions?.count ?? 0 == (sent["actions"] as? [Any])?.count ?? 0, "card.actions")
}

@Test func crowdIsShownOnceWhenTheDetailSaysIt() throws {
    // "… · crowding: high · or D2 in 14 min": not said again under it.
    let a = try golden("place")
    #expect(a.detail.contains("crowding: high"))
    #expect(a.crowdText == nil)
}

@Test func classCardLinesComeFromTheServer() throws {
    let a = try golden("class-bus")
    #expect(a.isClassPlan)
    #expect(a.catchHow == "Catch the ~09:42 R2 at PGP")
    #expect(a.catchArrive == "Arrive ~09:51 · 9 min early")
    #expect(a.goNowLine == "Or go now: R2 at 09:06 · arrive 09:15")
    #expect(a.card?.crowd == "Crowding: medium")
    let at = try #require(a.leaveAt)
    #expect(a.leaveHeadline(now: at.addingTimeInterval(-1)) == "Leave by ~09:36")
    #expect(a.leaveHeadline(now: at) == "Leave now")
}

@Test func otherKindsAreNotClassCards() throws {
    for name in ["place", "free", "rest", "arrived", "home", "setup"] { #expect(try !golden(name).isClassPlan, "\(name)") }
    #expect(try golden("class-late").leaveLate)
}

@Test func aDayWithoutClassesIsFree() throws {
    let a = try golden("free")
    #expect(a.isFree)
    #expect(a.departure == nil)
}

@Test func cardV2CarriesThePhaseAndOnlyPlans() throws {
    let a = try golden("class-late")
    #expect(a.card?.phase == "heading")
    #expect(a.tripUnderWay)
    #expect(a.card?.actions?.map(\.id) == ["skipped"])
    #expect((a.card?.glance?.count ?? 99) <= 12)
}

/// An older server's question decodes without trouble and is simply not shown.
@Test func aSuggestionDecodesAndAnOldQuestionIsIgnored() throws {
    let json = """
    {"label":"On the R2","detail":"Off at UTown","mode":"trip","card":{"kind":"trip","phase":"riding",
    "ask":{"trip":"4:600:UTOWN","question":"On the 9:41 R2?","actions":[{"id":"boarded","label":"On it","trip":"4:600:UTOWN"},
    {"id":"missed","label":"Missed it","trip":"4:600:UTOWN"}]},"remind":false,
    "suggestion":{"id":"quiet:4:600:UTOWN","text":"Stop reminders?","accept":"Stop reminders","dismiss":"Keep them"}}}
    """
    let a = try JSONDecoder().decode(NextAnswer.self, from: Data(json.utf8))
    #expect(a.card?.remind == false)
    #expect(a.card?.suggestion?.accept == "Stop reminders")
    let g = try golden("class-bus")
    #expect(g.card?.remind == true)
}

@MainActor @Test func theMenuBarShowsTheTripPhase() throws {
    let m = AppModel(snapshot: true)
    m.answers[.plan] = try golden("class-late")
    #expect(m.menuTitle(at: Date()) == m.plan?.card?.glance)
}

@MainActor @Test func staleFollowsTheServer() throws {
    let a = try golden("class-bus")
    let at = try #require(a.staleAt)
    let m = AppModel(snapshot: true)
    #expect(!m.isOld(a, at: at.addingTimeInterval(-1)))
    #expect(m.isOld(a, at: at))
}

@Test func datesParseWithOrWithoutMilliseconds() {
    #expect(parseISODate("2026-09-28T01:14:02Z") != nil)
    #expect(parseISODate("2026-09-28T01:14:02.000Z") == parseISODate("2026-09-28T01:14:02Z"))
}

@Test func versionsCompareNumerically() {
    #expect(isNewer("1.0.10", than: "1.0.9"))
    #expect(!isNewer("1.3.5", than: "1.3.5"))
    #expect(isNewer("2.0.0-beta", than: "1.3.10"))
    #expect(isNewer("2.0.0", than: "2.0.0-beta"))
    #expect(isNewer("2.0.0-beta.2", than: "2.0.0-beta"))
    #expect(!isNewer("2.0.0-beta", than: "2.0.0"))
    #expect(!isNewer("2.0.0-beta", than: "2.0.0-beta"))
    #expect(!isNewer("", than: "2.1.0"))
    #expect(isNewer("2.1.0", than: ""))
}

@Test func todaySaysTheBusYoureOnOrWhenToLeave() throws {
    let json = """
    {"date":"2026-10-01","items":[
      {"kind":"class","key":"a","label":"GEA1000 @ UTown","status":"next","fromName":"PGP","toName":"UTown","startsAt":"2026-10-01T02:00:00Z","onBus":{"svc":"D2","off":"UTown","arrive":"2026-10-01T01:50:00Z"}},
      {"kind":"class","key":"b","label":"CS2030 @ COM1","status":"later","fromName":"UTown","toName":"COM 3","startsAt":"2026-10-01T05:00:00Z","leave":{"at":"2026-10-01T04:40:00Z","estimated":true,"svc":"D2","stop":"UTown"},"timing":{"status":"late","text":"~3 min late"}},
      {"kind":"class","key":"c","label":"MA1100 @ LT21","status":"skipped","toName":"LT21","startsAt":"2026-10-01T07:00:00Z"},
      {"kind":"home","key":"h","label":"Home","status":"later","fromName":"COM 3","toName":"PGP","startsAt":"2026-10-01T09:00:00Z"}
    ],"note":null}
    """
    let day = try JSONDecoder().decode(DayPlan.self, from: Data(json.utf8))
    #expect(day.items[0].sub?.hasPrefix("On the D2 · off at UTown · arrive ") == true)
    let later = try #require(day.items[1].sub)
    #expect(later.hasPrefix("Leave by ~"))
    #expect(later.hasSuffix(" · D2 from UTown · ~3 min late"))
    #expect(day.items[2].sub == "Not going")
    #expect(day.items[3].title == "Home, from COM 3")
    #expect(day.items[3].sub == nil)
}

@Test func theServersErrorsAreShownAsSentences() {
    #expect(sentence("not a valid NUSMods share link") == "Not a valid NUSMods share link.")
    #expect(sentence("Nothing imported: no stop. Your timetable was not changed.") == "Nothing imported: no stop. Your timetable was not changed.")
}

/// After your day, on a free day and at home: the next class, worded on the server.
@Test(arguments: ["free", "rest", "home"])
func theNextClassComesWithTheCard(name: String) throws {
    let u = try #require(golden(name).card?.upcoming)
    #expect(u.title.hasPrefix("CS2030 at "))
    #expect(u.where.hasPrefix("At "))
    #expect(!u.when.isEmpty)
}

@Test func nearbyShowsTheBusesAfterTheNextFaded() throws {
    struct R: Decodable { let stops: [NearbyStop] }
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    let r = try JSONDecoder().decode(R.self, from: Data(contentsOf: dir.appendingPathComponent("nearby-list.json")))
    let d2 = try #require(r.stops.first?.board.first { $0.svc == "D2" })
    #expect(d2.later?.first?.etaS == 840)
    #expect(FlowPills.eta(d2) == "4 min", "the server's words")
    #expect(FlowPills.later(d2) == ["14 min"])
    #expect(FlowPills.spoken(d2) == "D2: 4 min, 14 min")
}

@Test func aTimetableGuessInNearbyIsNeverShownAsLive() {
    #expect(FlowPills.eta(etaS: 360, quality: "live") == "6 min")
    #expect(FlowPills.eta(etaS: 360, quality: "scheduled") == "~6 min")
    #expect(FlowPills.eta(etaS: 20, quality: "live") == "now")
    #expect(FlowPills.eta(etaS: nil, quality: "ended") == "ended")
    let row = BoardRow(svc: "D2", etaS: 240, quality: "live", later: [.init(etaS: 900, quality: "scheduled"), .init(etaS: 1500, quality: "live"), .init(etaS: 2100, quality: "live")])
    // At most two after the next one.
    #expect(FlowPills.later(row) == ["~15 min", "25 min"])
    // Spoken, the "~" is a word: VoiceOver doesn't read it.
    #expect(FlowPills.spoken(row) == "D2: 4 min, about 15 min, 25 min")
}

@Test func theTwoWaysOfNotGoingShareOneMenu() {
    let skip = CardAction(id: "skipped", label: "Not going", trip: "t")
    let away = CardAction(id: "away", label: "Not on campus today", trip: "t")
    let undo = CardAction(id: "reset", label: "Undo", trip: "u")
    #expect(AnswerDetail.grouped([skip, away, undo]) == [[skip, away], [undo]])
    #expect(AnswerDetail.grouped([skip, undo]) == [[skip], [undo]])
}

/// A golden's JSON with `edit` applied to it, decoded.
private func goldenEdited(_ name: String, _ edit: (inout [String: Any]) -> Void) throws -> NextAnswer {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    var o = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: dir.appendingPathComponent("\(name).json"))) as? [String: Any])
    edit(&o)
    return try JSONDecoder().decode(NextAnswer.self, from: JSONSerialization.data(withJSONObject: o))
}

private func editCard(_ o: inout [String: Any], _ edit: (inout [String: Any]) -> Void) {
    var card = o["card"] as? [String: Any] ?? [:]
    edit(&card)
    o["card"] = card
}

@Test func oneBrokenActionLeavesTheCard() throws {
    let a = try goldenEdited("class-late") { o in
        editCard(&o) { c in c["actions"] = (c["actions"] as? [Any] ?? []) + [["id": 5, "label": NSNull()]] }
    }
    let card = try #require(a.card, "the card survives")
    #expect(card.actions?.map(\.id) == ["skipped"], "only the broken action is left out")
    #expect(card.glance == "R2 09:06")
    #expect(a.tripUnderWay)
}

@Test func brokenNestedPartsOfTheCardAreLeftOut() throws {
    let a = try goldenEdited("free") { o in
        editCard(&o) { c in
            c["suggestion"] = ["id": "x"]
            c["upcoming"] = "tomorrow"
            c["actions"] = "none"
            c["late"] = "no"
        }
    }
    let card = try #require(a.card)
    #expect(card.suggestion == nil)
    #expect(card.upcoming == nil)
    #expect(card.actions == nil)
    #expect(card.late == nil)
    #expect(card.kind == "free")
    #expect(card.glance == "No classes")
}

@Test func aMissingOrUnknownKindIsATrip() throws {
    let missing = try goldenEdited("place") { o in editCard(&o) { $0.removeValue(forKey: "kind") } }
    #expect(missing.card?.kind == "trip")
    let unknown = try goldenEdited("class-bus") { o in editCard(&o) { $0["kind"] = "teleport" } }
    #expect(unknown.card?.kind == "trip")
    #expect(unknown.card?.leaveBy == "Leave by ~09:36")
    let number = try goldenEdited("place") { o in editCard(&o) { $0["kind"] = 3 } }
    #expect(number.card?.kind == "trip")
}

/// A newer server's phase and quality: the answer shows, no trip is
/// followed for it, and its times aren't shown as live.
@Test func anUnknownPhaseAndQualityAreNeitherATripNorLive() throws {
    let a = try goldenEdited("class-bus") { o in
        o["quality"] = "predicted"
        editCard(&o) { $0["phase"] = "boarding" }
    }
    #expect(a.card?.phase == "boarding")
    #expect(a.quality == "predicted")
    #expect(!a.tripUnderWay)
    #expect(a.leaveHeadline(now: .distantPast) == "Leave by ~09:36")
    #expect(Header.dotColor(a.quality, error: false, nearby: false) == .gray)
    #expect(Header.dotColor("live", error: false, nearby: false) == .green)
}

@Test func theDestinationNeedsNoCode() throws {
    let a = try goldenEdited("class-bus") { o in
        var d = o["dest"] as? [String: Any] ?? [:]
        d.removeValue(forKey: "to")
        o["dest"] = d
    }
    #expect(a.dest?.label != nil)
    #expect(a.dest?.to == nil)
}

@MainActor @Test func theMenuBarShowsTheServersGlance() throws {
    let m = AppModel(snapshot: true)
    for name in ["class-bus", "place", "free", "home", "setup"] {
        m.answers[.plan] = try golden(name)
        #expect(m.menuTitle(at: Date()) == m.plan?.card?.glance, "\(name)")
    }
    m.answers[.plan] = try golden("class-bus")
    // Whatever the time: the glance is a clock time, not a count.
    let at = try #require(m.plan?.leaveAt)
    #expect(m.menuTitle(at: at.addingTimeInterval(600)) == "Leave 09:36")
}

/// Offline with no day plan kept, an old glance would pass for current: the plain icon instead.
@MainActor @Test func offlineTheMenuBarDropsAGlanceGoneStale() throws {
    let m = AppModel(snapshot: true)
    m.answers[.plan] = try golden("class-bus")
    let stale = try #require(m.plan?.card?.staleAt.flatMap(parseISODate))
    m.error = "Offline"
    #expect(m.menuTitle(at: stale.addingTimeInterval(-1)) == m.plan?.card?.glance)
    #expect(m.menuTitle(at: stale) == nil)
    m.error = nil
    #expect(m.menuTitle(at: stale) == m.plan?.card?.glance)
}

/// The rule every client follows: a card without staleAt never dims; only an answer with no card is old.
@MainActor @Test func onlyAnAnswerWithoutACardIsOldWithoutStaleAt() throws {
    let m = AppModel(snapshot: true)
    let now = Date()
    for name in ["class-bus", "setup", "rest", "free"] {
        let a = try goldenEdited(name) { o in editCard(&o) { $0["staleAt"] = NSNull() } }
        #expect(!m.isOld(a, at: now), "\(name)")
    }
    let noCard = try goldenEdited("place") { $0.removeValue(forKey: "card") }
    #expect(m.isOld(noCard, at: now))
    #expect(!m.isOld(nil, at: now))
}

@MainActor @Test func offThePlansTabTheMenuBarsPlanIsReused() throws {
    let m = AppModel(snapshot: true)
    let a = try golden("class-bus")
    let staleAt = try #require(a.staleAt)
    let fetched = staleAt.addingTimeInterval(-120)
    #expect(m.planDue(at: fetched), "no plan yet")
    m.answers[.plan] = a
    #expect(m.planDue(at: fetched), "never fetched here")
    m.planFetched = fetched
    #expect(!m.planDue(at: fetched.addingTimeInterval(60), local: fetched.addingTimeInterval(60)), "a minute old, nothing passed")
    #expect(m.planDue(at: fetched.addingTimeInterval(60), local: fetched.addingTimeInterval(301)), "over 5 minutes old")
    #expect(m.planDue(at: staleAt, local: fetched.addingTimeInterval(120)), "one of its own times has passed")
}

@Test func theServersClockComesFromItsDateHeader() throws {
    let local = try #require(ServerClock.parseHTTPDate("Wed, 07 Oct 2026 01:14:02 GMT"))
    #expect(local == parseISODate("2026-10-07T01:14:02Z"))
    #expect(ServerClock.parseHTTPDate("yesterday") == nil)
    // Date's one-second steps and the trip there: not a wrong clock.
    #expect(ServerClock.skew(server: local.addingTimeInterval(2.9), local: local) == 0)
    #expect(ServerClock.skew(server: local.addingTimeInterval(-2.9), local: local) == 0)
    #expect(ServerClock.skew(server: local.addingTimeInterval(90), local: local) == 90, "this Mac is 90 s slow")
    #expect(ServerClock.skew(server: local.addingTimeInterval(-45), local: local) == -45, "this Mac is 45 s fast")
    let url = URL(string: "https://terminus.rcn.sh/me/next")!
    let fresh = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Date": "Wed, 07 Oct 2026 01:15:32 GMT", "Cache-Control": "no-store"]))
    #expect(ServerClock.skew(from: fresh, at: local) == 90)
    let cached = try #require(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Date": "Wed, 07 Oct 2026 01:15:32 GMT", "Cache-Control": "private, max-age=5"]))
    #expect(ServerClock.skew(from: cached, at: local) == nil, "a cached answer was dated when it was first sent")
    #expect(ServerClock.now(local: local, skew: 90) == local.addingTimeInterval(90))
}

@Test func theCardSaysItsTitleAndHeading() throws {
    let bus = try golden("class-bus")
    #expect(bus.card?.title == "R2 · 09:06")
    #expect(bus.card?.heading == "Next class · GEA1000 @ UTown")
    #expect(try golden("scheduled").card?.title == "A1 · ~09:11", "a timetable guess keeps its ~")
    #expect(try golden("free").card?.heading == nil)
    #expect(try golden("riding").card?.phaseText == "On the bus")
}

@Test func theReminderGoesWhenTheServerSays() throws {
    let bus = try golden("class-bus")
    let at = try #require(bus.card?.remindAt.flatMap(parseISODate))
    let leave = try #require(bus.leaveAt)
    #expect(at < leave)
    #expect(try golden("place").card?.remindAt == nil, "no reminder for this trip")
}

@Test func theJourneyComesAsSteps() throws {
    let j = try #require(try golden("class-bus").card?.journey)
    #expect(j.title == "To GEA1000 @ UTown · starts 10:00")
    #expect(j.walkText == "5 min walk")
    #expect(j.rideText == "10 min ride")
    #expect(j.arriveText == "Arrive ~09:51 · 9 min early")
    #expect(j.backupText == "Or go now: R2 at 09:06 from PGP")
    #expect(j.bus?.svc == "R2")
    // One line the wrong type: only it is left out.
    let odd = try goldenEdited("class-bus") { o in editCard(&o) { c in
        var j = c["journey"] as? [String: Any] ?? [:]
        j["walkText"] = 5
        c["journey"] = j
    } }
    #expect(odd.card?.journey?.walkText == nil)
    #expect(odd.card?.journey?.title == j.title)
}

@Test func theRideGoesFromBoardingToGettingOff() throws {
    let r = try #require(try golden("riding").card?.ride)
    #expect(r.svc == "R2")
    #expect(r.stops.first?.name == "PGP")
    #expect(r.stops.last?.name == "UTown")
    let board = try #require(parseISODate(r.board)), arrive = try #require(parseISODate(r.arrive))
    #expect(r.progress(at: board.addingTimeInterval(-60)) == 0)
    #expect(r.passed(at: board) == 0)
    #expect(r.passed(at: board.addingTimeInterval(arrive.timeIntervalSince(board) / 2)) == 3, "halfway: three of six stops passed")
    #expect(r.passed(at: arrive) == r.stops.count - 1)
    let short = try goldenEdited("riding") { o in editCard(&o) { c in
        var ride = c["ride"] as? [String: Any] ?? [:]
        ride["stops"] = [["code": "PGP", "name": "PGP"]]
        c["ride"] = ride
    } }
    #expect(short.card != nil && short.card?.ride == nil, "one stop is no ride")
}

@MainActor @Test func aSetupCardAsksForSetup() throws {
    let m = AppModel(snapshot: true)
    m.paired = true
    m.answers[.plan] = try golden("setup")
    #expect(m.plan?.card?.kind == "setup")
    #expect(m.wantsSetup)
    #expect(m.menuTitle(at: Date()) == "Set up")
    m.answers[.plan] = try golden("no-timetable")
    #expect(!m.wantsSetup, "no timetable yet is a free day, not setup")
}

@Test func todaysLinesComeFromTheServer() throws {
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures/answers").standardized
    let day = try JSONDecoder().decode(DayPlan.self, from: Data(contentsOf: dir.appendingPathComponent("day.json")))
    #expect(day.items[0].sub == "Leave by ~09:36 · R2 from PGP")
    #expect(day.items[1].title == "Home, from UTown")
    #expect(day.items[1].sub == nil)
}

/// The search every client is held to (apps/api/test/fixtures/search.json).
/// The Mac has no Buses tab, so only its "destinations" section.
@Test func theSearchFollowsTheSharedCases() throws {
    struct Fixture: Decodable {
        struct Section: Decodable {
            struct Query: Decodable { let q: String; let expect: [String]; let why: String? }
            let limit: Int
            let index: [Destination]
            let queries: [Query]
        }
        let destinations: Section
    }
    let dir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../api/test/fixtures").standardized
    let f = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: dir.appendingPathComponent("search.json"))).destinations
    #expect(!f.queries.isEmpty)
    for c in f.queries {
        let got = rankDestinations(f.index, c.q, max: f.limit).map { "\($0.kind):\($0.code)" }
        #expect(got == c.expect, "\(c.q.debugDescription): \(c.why ?? "")")
    }
    #expect(rankDestinations(f.index, "a").count <= 8, "8 by default")
}

@Test func aResidencesWalkIsTheServers() throws {
    let json = #"{"stops": [], "residences": [{"code": "PGPR", "name": "PGP Residences", "stops": ["PGP"], "walkM": 300, "walkMin": 6}, {"code": "OLD", "name": "Old", "stops": ["COM3"], "walkM": 420}]}"#
    let c = try JSONDecoder().decode(Campus.self, from: Data(json.utf8))
    let pgp = try #require(c.residences.first { $0.code == "PGPR" })
    #expect(SetupModel.homeWalk(pgp, within: 0...30) == 6, "not 300 m at 1.3 m/s (4 min)")
    let old = try #require(c.residences.first { $0.code == "OLD" })
    #expect(SetupModel.homeWalk(old, within: 0...30) == 5, "an older server: worked out here")
    #expect(SetupModel.homeWalk(pgp, within: 0...3) == 3, "held to the account's limit")
}

@Test func theProfileSaysItsLimits() {
    let l = SetupModel.Limits(["homeStops": 4, "places": 20, "placeLabel": 30, "homeWalkMin": ["min": 1, "max": 45]])
    #expect(l.homeStops == 4)
    #expect(l.places == 20)
    #expect(l.placeLabel == 30)
    #expect(l.homeWalkMin == 1...45)
    let old = SetupModel.Limits(nil)
    #expect(old.homeStops == 3 && old.places == 12 && old.placeLabel == 24 && old.homeWalkMin == 0...30, "today's values without them")
}

/// VoiceOver hears where the bus is and how far is left, not every stop.
@Test func theRideIsSpokenAsTheNextStopAndWhatsLeft() {
    let stops = ["PGP", "Kent Ridge MRT", "LT27", "UTown"]
    #expect(AnswerDetail.RideLine.spoken(stops, passed: 0) == "Next stop: Kent Ridge MRT. 3 stops to go, getting off at UTown.")
    #expect(AnswerDetail.RideLine.spoken(stops, passed: 2) == "Next stop: UTown, where you get off.")
    #expect(AnswerDetail.RideLine.spoken(stops, passed: 3) == "Next stop: UTown, where you get off.")
}
