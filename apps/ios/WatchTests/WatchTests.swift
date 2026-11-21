import Foundation
import Testing

@testable import TerminusWatch

let fixtures = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("../../fixtures").standardized

func golden(_ name: String) throws -> (NextAnswer, Date) {
    let data = try Data(contentsOf: fixtures.appendingPathComponent("answers/\(name).json"))
    let a = try NextAnswer.decode(data)
    let raw = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return (a, try #require((raw["asOf"] as? String).flatMap(parseISODate)))
}

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

    @Test func aClassByBusCountsDownToLeaving() throws {
        let (a, now) = try golden("class-bus")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.headline == "Leave in 37 min")
        #expect(g.big == "37 min")
        #expect(g.svc == "R2")
        #expect(g.color == "#34a853")
        #expect(g.under == "from PGP ~09:42")
        #expect(g.sure == "~")
        #expect(g.inline == "Leave in 37 min · R2")
        #expect(g.countdownTo == nil)
    }

    @Test func aLiveBusSaysLive() throws {
        let (a, now) = try golden("place")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.svc == "A1")
        #expect(g.sure == "Live")
        #expect(g.headline.hasPrefix("Leave in "))
    }

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

    @Test func onFootSaysWhenYouGetThere() throws {
        let (a, now) = try golden("class-walk")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.svc == nil)
        #expect(g.sure == nil)
        #expect(g.under == a.card?.journey.flatMap { JourneyText.arrive($0) })
    }

    @Test func onTheBusItSaysWhereToGetOff() throws {
        let (a, now) = try golden("riding")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        let off = try #require(a.card?.ride?.stops.last?.name)
        #expect(g.headline.hasPrefix("Off at \(off)"))
        #expect(g.under == a.card?.ride?.nextText(at: now))
        #expect(g.inline == a.card?.glance)
    }

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

    @Test func chineseCountsDownInChinese() throws {
        Lang.pref = "zh"
        defer { Lang.pref = "en" }
        let (a, now) = try golden("zh/class-bus")
        let g = Glance.of(paired: true, answer: a, error: nil, now: now)
        #expect(g.headline == "37 分钟后出发")
        #expect(g.under?.hasPrefix(L("from %@", "PGP")) == true)
    }

    @Test func oneAnswersTimelineRedrawsAsTheCountdownMoves() throws {
        let (a, now) = try holding("class-bus")
        let leave = try #require(a.leaveAt)
        let marks = Glance.redraws(a, now: now, until: now.addingTimeInterval(3 * 3600))
        #expect(marks.contains(leave))
        #expect(marks.contains(leave.addingTimeInterval(-119.5)))
        #expect(marks == marks.sorted())
        #expect(marks.allSatisfy { $0 > now })
        #expect(marks.filter { $0 < leave.addingTimeInterval(-120) }.count >= 35)
        let (kept, keptNow) = try golden("class-bus")
        let stale = try #require(kept.staleAt)
        #expect(
            !Glance.redraws(kept, now: keptNow, until: keptNow.addingTimeInterval(3 * 3600)).contains {
                $0 > stale && $0 < leave.addingTimeInterval(-120) && !WidgetTiming.redraws(kept, now: keptNow, until: leave).contains($0)
            })
        for m in WidgetTiming.redraws(a, now: now, until: now.addingTimeInterval(3 * 3600)) { #expect(marks.contains(m)) }
        for m in marks where m < leave.addingTimeInterval(-120) {
            let before = Glance.of(paired: true, answer: a, error: nil, now: m.addingTimeInterval(-1))
            let after = Glance.of(paired: true, answer: a, error: nil, now: m.addingTimeInterval(1))
            if WidgetTiming.redraws(a, now: now, until: leave).contains(m) { continue }
            #expect(before.headline != after.headline, "at \(m)")
        }
        let mid = Glance.of(paired: true, answer: a, error: nil, now: now.addingTimeInterval(5))
        let later = Glance.of(paired: true, answer: a, error: nil, now: now.addingTimeInterval(9))
        #expect(mid.headline == later.headline)
    }

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
    #expect(WatchHandoff.code(in: m, tried: "ABC234", now: at) == nil)
    #expect(WatchHandoff.code(in: m, tried: "XYZ789", now: at) != nil)
}

@Test func theWatchTellsThePhoneHowItWasSignedOut() {
    for s in [WatchHandoff.State(signedIn: true), .init(signedIn: false, out: .you), .init(signedIn: false, out: .server)] {
        #expect(WatchHandoff.state(in: WatchHandoff.context(s)) == s)
    }
    #expect(WatchHandoff.state(in: [:]) == nil)
}

@Test func theWatchSaysItsTheWatch() {
    #expect(Api.client == "ios-watch/\(Api.version)")
}

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
