import Foundation
import Testing

@testable import TerminusWatch

/// The watch on the API's golden answers (fixtures/answers), which the
/// server's own tests pin word for word, as the phone's tests read them.
let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("../../fixtures").standardized

/// A golden answer and the moment it was made (its `asOf`).
func golden(_ name: String) throws -> (NextAnswer, Date) {
    let data = try Data(contentsOf: fixtures.appendingPathComponent("answers/\(name).json"))
    let a = try NextAnswer.decode(data)
    let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return (a, try #require((raw["asOf"] as? String).flatMap(parseISODate)))
}

/// A golden whose card holds until after its leave time, as one fetched
/// a moment before leaving does: for the countdown's last minutes.
func holding(_ name: String) throws -> (NextAnswer, Date) {
    let data = try Data(contentsOf: fixtures.appendingPathComponent("answers/\(name).json"))
    var raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    var card = try #require(raw["card"] as? [String: Any])
    let at: String? = (raw["leave"] as? [String: Any])?["at"] as? String
    let leave = try #require(at.flatMap { parseISODate($0) })
    card["staleAt"] = ISO8601DateFormatter().string(from: leave.addingTimeInterval(600))
    card["nextChangeAt"] = nil
    raw["card"] = card
    let a = try NextAnswer.decode(JSONSerialization.data(withJSONObject: raw))
    return (a, try #require((raw["asOf"] as? String).flatMap(parseISODate)))
}

/// Every /me/next golden, English and Chinese.
func nextGoldens() -> [String] {
    let dir = fixtures.appendingPathComponent("answers")
    let names = { (sub: String) in
        ((try? FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent(sub).path)) ?? [])
            .filter { $0.hasSuffix(".json") }.map { (sub.isEmpty ? "" : "\(sub)/") + String($0.dropLast(5)) }
    }
    return (names("") + names("zh")).filter { n in
        guard let d = try? Data(contentsOf: dir.appendingPathComponent("\(n).json")),
            let o = try? JSONSerialization.jsonObject(with: d) as? [String: Any]
        else { return false }
        return o["card"] != nil
    }.sorted()
}

@Suite(.serialized) struct WatchGlanceTests {
    init() { Lang.pref = "en" }

    @Test func theGoldensAreFound() {
        #expect(nextGoldens().count >= 40)
    }

    /// A class by bus: when to leave counts down, the bus and its stop under it, "~" for a timetable time.
    @Test func aClassByBusCountsDownToLeaving() throws {
        let (a, now) = try golden("class-bus")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        // 01:36:40 less 01:00:00 is 36 min 40 s, rounded as the phone's Now rounds it.
        #expect(g.headline == "Leave in 37 min")
        #expect(g.big == "37 min")
        #expect(g.svc == "R2")
        #expect(g.color == "#34a853")
        #expect(g.under == "from PGP ~09:42")
        #expect(g.sure == "~")
        #expect(g.inline == "Leave in 37 min · R2")
        #expect(g.countdownTo == nil)
    }

    /// A live bus is "Live".
    @Test func aLiveBusSaysLive() throws {
        let (a, now) = try golden("place")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.svc == "A1")
        #expect(g.sure == "Live")
        #expect(g.headline.hasPrefix("Leave in "))
    }

    /// The last two minutes tick by themselves, to the leave time.
    @Test func theLastTwoMinutesAreATimer() throws {
        let (a, _) = try holding("class-bus")
        let leave = try #require(a.leaveAt)
        let g = Glance.of(paired: true, answer: a, error: nil, now: leave.addingTimeInterval(-90))
        #expect(g.countdownTo == leave)
        #expect(g.big == nil)
        let after = Glance.of(paired: true, answer: a, error: nil, now: leave.addingTimeInterval(1))
        #expect(after.headline == "Leave now")
        #expect(after.countdownTo == nil)
    }

    /// On foot: no bus, and when you get there under it.
    @Test func onFootSaysWhenYouGetThere() throws {
        let (a, now) = try golden("class-walk")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.svc == nil)
        #expect(g.sure == nil)
        #expect(g.under == a.card?.journey.flatMap { JourneyText.arrive($0) })
    }

    /// On the bus: where to get off, as the phone's widgets say it, and the next stop.
    @Test func onTheBusItSaysWhereToGetOff() throws {
        let (a, now) = try golden("riding")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        let off = try #require(a.card?.ride?.stops.last?.name)
        #expect(g.headline.hasPrefix("Off at \(off)"))
        #expect(g.under == a.card?.ride?.nextText(at: now))
        #expect(g.inline == a.card?.glance)
    }

    /// A day that's done: the card's own words, and its glance beside the clock.
    @Test func aDayThatsDoneSaysSo() throws {
        for name in ["rest", "free"] {
            let (a, now) = try golden(name)
            let g = Glance.of(paired: true, answer: a, error: nil, now: now)
            #expect(g.headline == a.label)
            #expect(g.inline == a.card?.glance)
            #expect(g.svc == nil)
        }
    }

    @Test func signedOutItSaysWhereToSetUp() {
        let g = Glance.of(paired: false, answer: nil, error: nil, now: Date())
        #expect(g.headline == "terminus")
        #expect(g.under == "Open terminus on your iPhone")
    }

    /// Every card state has a headline, the face's words when it isn't
    /// counting down (nothing worded on the watch alone, rule 1).
    @Test(arguments: nextGoldens())
    func everyGoldenHasAHeadline(name: String) throws {
        Lang.pref = name.hasPrefix("zh/") ? "zh" : "en"
        defer { Lang.pref = "en" }
        let (a, now) = try golden(name)
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(!g.headline.isEmpty)
        if !g.isCountdown {
            let face = WidgetFace.of(paired: true, mode: .timetable, answer: a, error: nil, offline: nil, now: now)
            if a.card?.journey == nil || WidgetFace.isOld(a, now: now) || a.phase == "riding" { #expect(g.headline == face.headline) }
        }
    }

    /// Chinese from the Chinese golden: the countdown in the phone's Chinese.
    @Test func chineseCountsDownInChinese() throws {
        Lang.pref = "zh"
        defer { Lang.pref = "en" }
        let (a, now) = try golden("zh/class-bus")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.headline == "37 分钟后出发")
        #expect(g.under?.hasPrefix(L("from %@", "PGP")) == true)
    }

    /// One answer's timeline: a redraw each time the countdown's figure
    /// changes, the timer's start and leaving, and each is a real change.
    @Test func oneAnswersTimelineRedrawsAsTheCountdownMoves() throws {
        let (a, now) = try holding("class-bus")
        let leave = try #require(a.leaveAt)
        let marks = Glance.redraws(a, now: now, until: now.addingTimeInterval(3 * 3600))
        #expect(marks.contains(leave))
        #expect(marks.contains(leave.addingTimeInterval(-119.5)))
        #expect(marks == marks.sorted())
        #expect(marks.allSatisfy { $0 > now })
        // A minute's mark for every minute from 37 down to 2.
        #expect(marks.filter { $0 < leave.addingTimeInterval(-120) }.count >= 35)
        // Past a card's staleAt the countdown isn't drawn, so neither are its marks.
        let (kept, keptNow) = try golden("class-bus")
        let stale = try #require(kept.staleAt)
        #expect(
            !Glance.redraws(kept, now: keptNow, until: keptNow.addingTimeInterval(3 * 3600)).contains {
                $0 > stale && $0 < leave.addingTimeInterval(-120) && !WidgetTiming.redraws(kept, now: keptNow, until: leave).contains($0)
            })
        // The iPhone widget's own moments too.
        for m in WidgetTiming.redraws(a, now: now, until: now.addingTimeInterval(3 * 3600)) { #expect(marks.contains(m)) }
        // Just before and just after a minute's mark, the glance says something different.
        for m in marks where m < leave.addingTimeInterval(-120) {
            let before = Glance.of(paired: true, answer: a, error: nil, now: m.addingTimeInterval(-1))
            let after = Glance.of(paired: true, answer: a, error: nil, now: m.addingTimeInterval(1))
            if WidgetTiming.redraws(a, now: now, until: leave).contains(m) { continue }
            #expect(before.headline != after.headline, "at \(m)")
        }
        // Between two marks it says the same thing throughout.
        let mid = Glance.of(paired: true, answer: a, error: nil, now: now.addingTimeInterval(5))
        let later = Glance.of(paired: true, answer: a, error: nil, now: now.addingTimeInterval(9))
        #expect(mid.headline == later.headline)
    }

    /// The Smart Stack wants it most in the hour before leaving and on a trip.
    @Test func theSmartStackWantsItNearLeaving() throws {
        let (a, now) = try golden("class-bus")
        #expect(Glance.relevance(paired: true, answer: a, now: now) == 0.8)
        let (r, rNow) = try golden("riding")
        #expect(Glance.relevance(paired: true, answer: r, now: rNow) == 1)
        let (free, fNow) = try golden("free")
        #expect(Glance.relevance(paired: true, answer: free, now: fNow) == 0.1)
        #expect(Glance.relevance(paired: false, answer: a, now: now) == 0)
    }
}

// MARK: the hand-off from the phone

@Test func aPairingCodeCrossesWithTheSettings() throws {
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    let sent = WatchHandoff.Code(code: "ABC234", lang: "zh", clock: "24", sentAt: at)
    let got = try #require(WatchHandoff.code(in: WatchHandoff.message(sent), now: at.addingTimeInterval(60)))
    #expect(got == sent)
}

@Test func aCodeThatWaitedTooLongIsNotTried() {
    let at = Date(timeIntervalSince1970: 1_800_000_000)
    let m = WatchHandoff.message(WatchHandoff.Code(code: "ABC234", lang: "en", clock: "auto", sentAt: at))
    #expect(WatchHandoff.code(in: m, now: at.addingTimeInterval(WatchHandoff.codeLife)) == nil)
    #expect(WatchHandoff.code(in: ["pairCode": "", "sentAt": at.timeIntervalSince1970], now: at) == nil)
    #expect(WatchHandoff.code(in: [:], now: at) == nil)
}

@Test func theWatchTellsThePhoneHowItWasSignedOut() {
    for s in [WatchHandoff.State(signedIn: true), .init(signedIn: false, out: .you), .init(signedIn: false, out: .server)] {
        #expect(WatchHandoff.state(in: WatchHandoff.context(s)) == s)
    }
    #expect(WatchHandoff.state(in: [:]) == nil)
}

/// The server knows the watch by its client header: the iPhone app's platform, with its own flavour.
@Test func theWatchSaysItsTheWatch() {
    #expect(Api.client == "ios-watch/\(Api.version)")
}

/// The account's language, from the language its answers come in.
@Test func theWatchFollowsTheAccountsLanguage() {
    let before = Lang.pref
    defer { Lang.pref = before }
    Lang.pref = "en"
    #expect(WatchPlan.follow("zh-Hans"))
    #expect(Lang.pref == "zh")
    #expect(!WatchPlan.follow("zh-Hans"))
    #expect(WatchPlan.follow("en"))
    #expect(Lang.pref == "en")
    #expect(!WatchPlan.follow(nil))
}
