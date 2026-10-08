import Foundation
import Testing
@testable import Terminus

/// How the app takes the server's refusals and replies it only partly
/// understands: waits as long as it's asked, and keeps what it can read.

@Test func retryAfterIsReadInEitherForm() {
    let now = Date(timeIntervalSince1970: 1_791_000_000)
    #expect(retryAfterS("120", now: now) == 120)
    #expect(retryAfterS(" 30 ", now: now) == 30)
    #expect(retryAfterS("0", now: now) == nil)
    #expect(retryAfterS(nil, now: now) == nil)
    #expect(retryAfterS("soon", now: now) == nil)
    let later = ServerClock.parseHTTPDate("Wed, 07 Oct 2026 01:16:02 GMT")!
    #expect(retryAfterS("Wed, 07 Oct 2026 01:16:02 GMT", now: later.addingTimeInterval(-90)) == 90)
    #expect(retryAfterS("Wed, 07 Oct 2026 01:16:02 GMT", now: later.addingTimeInterval(10)) == nil)
}

/// A mistyped sign-in code doesn't silence the menu bar, nor the other way round.
@Test func signingInAndTheAnswersWaitApart() {
    #expect(Quiet.scope("/auth/app/code") == .signIn)
    #expect(Quiet.scope("/auth/anon") == .signIn)
    #expect(Quiet.scope("/pair") == .signIn)
    #expect(Quiet.scope("/me/next") == .app)
    #expect(Quiet.scope("/me/pair-code") == .app)

    let appBefore = Quiet.until(.app)
    Quiet.after("120", scope: .signIn)
    #expect(Quiet.until(.signIn) > Date().addingTimeInterval(100))
    #expect(Quiet.until(.app) == appBefore)
    // At most 5 minutes, whatever the header says.
    Quiet.after("86400", scope: .signIn)
    #expect(Quiet.until(.signIn) <= Date().addingTimeInterval(300))
    // Over again, so no other test meets it.
    Quiet.after("1", scope: .signIn, now: .distantPast)
    #expect(Quiet.until(.signIn) < Date())
}

@Test func aReplyThisVersionCantReadIsntCalledOffline() {
    let bad = DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "x"))
    #expect(failureMessage(bad) == L("terminus sent something this version can't read."))
    #expect(failureMessage(URLError(.notConnectedToInternet)) == L("Couldn't reach terminus. Check your connection and try again."))
    #expect(failureMessage(ApiError(status: 400, message: "That code isn't right.")) == "That code isn't right.")
    #expect(ApiError(status: 426, message: "").updateRequired)
}

/// One odd row or a fractional number loses that row, never the whole reply.
@Test func nearbyStopsKeepWhatTheyCanRead() throws {
    struct R: Decodable { let stops: [NearbyStop] }
    let json = """
    {"stops": [
      {"stop": {"code": "COM3", "name": "COM 3"}, "walkS": 95.6, "available": true,
       "board": [{"svc": "D2", "etaS": 120, "quality": "live"}, {"svc": 7}]},
      {"stop": {"code": "UTOWN", "name": "University Town"}}
    ]}
    """
    let r = try JSONDecoder().decode(R.self, from: Data(json.utf8))
    #expect(r.stops.count == 2)
    #expect(r.stops[0].walkS == 96)
    #expect(r.stops[0].board.map(\.svc) == ["D2"])
    #expect(r.stops[1].walkS == 0)
    #expect(r.stops[1].board.isEmpty)
}

@Test func aDestinationWithAFractionalWalkStays() throws {
    let json = #"{"code": "FINEFOOD", "label": "Fine Food", "stopCode": "UTOWN", "kind": "landmark", "walkM": 120.4, "aliases": ["food", 3]}"#
    let d = try JSONDecoder().decode(Destination.self, from: Data(json.utf8))
    #expect(d.walkM == 120)
    #expect(d.aliases == ["food"])
    #expect(d.goesTo == "FINEFOOD")
}

@Test func todayKeepsTheEntriesItCanRead() throws {
    let json = """
    {"date": "2026-10-08", "items": [
      {"kind": "class", "key": "CS2030", "label": "CS2030", "status": "next", "startsAt": "2026-10-08T02:00:00Z"},
      {"kind": "class", "key": "broken"}
    ]}
    """
    let day = try JSONDecoder().decode(DayPlan.self, from: Data(json.utf8))
    #expect(day.items.map(\.key) == ["CS2030"])
    #expect(day.date == "2026-10-08")
}
