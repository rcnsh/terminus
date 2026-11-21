import Foundation
import Testing

@testable import Terminus

private let answers = fixtures.appendingPathComponent("answers")

func goldenNames() -> [String] {
    let names = { (sub: String) in
        ((try? FileManager.default.contentsOfDirectory(atPath: answers.appendingPathComponent(sub).path)) ?? [])
            .filter { $0.hasSuffix(".json") }
            .map { (sub.isEmpty ? "" : "\(sub)/") + String($0.dropLast(5)) }
    }
    return (names("") + names("zh")).sorted()
}

@Test func aNearbyStopKnowsItsOpposite() throws {
    struct R: Decodable { let stops: [NearbyStop] }
    let data = try Data(contentsOf: answers.appendingPathComponent("nearby-list.json"))
    let foyer = try #require(try JSONDecoder().decode(R.self, from: data).stops.first { $0.stop.code == "PGPR" })
    #expect(foyer.opposite == "PGP")
    #expect(foyer.oppositeAcross == false)
    #expect(foyer.oppositeName == "Prince George's Park")
}

@Test func theStepBetweenBusesDecodes() throws {
    let data = try Data(contentsOf: answers.appendingPathComponent("class-bus.json"))
    let s = try #require(try NextAnswer.decode(data).card?.step)
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let sent = try #require((json["card"] as? [String: Any])?["step"] as? [String: Any])
    #expect(s.trip == sent["trip"] as? String)
    #expect(s.moved == false)
    #expect(s.earlierLabel == "Earlier bus")
    #expect(s.laterLabel == "Later bus")
    #expect(s.bestLabel == "Best bus")
    let earlier = try #require(s.earlier)
    #expect(earlier.svc == "D2")
    #expect(earlier.fields == sent["earlier"] as? [String: String])
    #expect(s.later?.fields == sent["later"] as? [String: String])

    let zh = try #require(try NextAnswer.decode(Data(contentsOf: answers.appendingPathComponent("zh/class-bus.json"))).card?.step)
    #expect(zh.laterLabel != "Later bus")

    let arrived = try NextAnswer.decode(Data(contentsOf: answers.appendingPathComponent("arrived.json")))
    #expect(arrived.card != nil)
    #expect(arrived.card?.step == nil)
}

@Test func aStepWithNoBusThatWayIsNil() throws {
    let json = Data(
        #"{"trip":"t","earlier":null,"later":{"svc":"A1","stop":"COM3","board":"2026-10-07T01:00:00Z"},"moved":true,"earlierLabel":"E","laterLabel":"L","bestLabel":"B"}"#
            .utf8)
    let s = try JSONDecoder().decode(Step.self, from: json)
    #expect(s.earlier == nil)
    #expect(s.later?.stop == "COM3")
    #expect(s.moved)
}

@Test func theGoldensAreFound() {
    #expect(goldenNames().count >= 40)
}

@Test(arguments: goldenNames())
func everyGoldenAnswerDecodes(name: String) throws {
    let data = try Data(contentsOf: answers.appendingPathComponent("\(name).json"))
    let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    if json["stops"] != nil {
        struct R: Decodable { let stops: [NearbyStop] }
        let stops = try JSONDecoder().decode(R.self, from: data).stops
        #expect(stops.count == (json["stops"] as? [Any])?.count)
        return
    }
    if json["items"] != nil {
        let day = try JSONDecoder().decode(DayPlan.self, from: data)
        #expect(day.items.count == (json["items"] as? [Any])?.count)
        return
    }
    let a = try NextAnswer.decode(data)
    let card = try #require(a.card, "\(name) has a card")
    let sent = try #require(json["card"] as? [String: Any])
    let present = { (key: String) in sent[key] != nil && !(sent[key] is NSNull) }
    if present("journey") { #expect(card.journey != nil, "card.journey") }
    if present("ride") { #expect(card.ride != nil, "card.ride") }
    if present("upcoming") { #expect(card.upcoming != nil, "card.upcoming") }
    if present("suggestion") { #expect(card.suggestion != nil, "card.suggestion") }
    if present("walkTo") { #expect(card.walkTo != nil, "card.walkTo") }
    if present("step") { #expect(card.step != nil, "card.step") } else { #expect(card.step == nil, "card.step") }
    if (sent["journey"] as? [String: Any])?["change"] is [String: Any] { #expect(card.journey?.change != nil, "journey.change") }
    if (sent["ride"] as? [String: Any])?["change"] is [String: Any] { #expect(card.ride?.change != nil, "ride.change") }
    #expect(card.actions.count == (sent["actions"] as? [Any])?.count ?? 0, "card.actions")
    #expect(a.places.count == (json["places"] as? [Any])?.count ?? 0, "places")
}

@Test(arguments: goldenNames())
func everyGoldenIsSpokenInSentences(name: String) throws {
    let data = try Data(contentsOf: answers.appendingPathComponent("\(name).json"))
    guard let a = try? NextAnswer.decode(data), a.card != nil else { return }
    let said = Spoken.summary(a, now: parseISODate(a.asOf ?? "") ?? Date(), withHead: true)
    #expect(!said.isEmpty, "\(name) says something")
    #expect(!said.contains(" · "), "\(name): \(said)")
}

@Test func theCountdownSaysAMinuteAgoFromTheStart() {
    #expect(Countdown.words(left: 61) == "Leaves in 1 min 1 s")
    #expect(Countdown.words(left: 1) == "Leaves in 1 s")
    #expect(Countdown.words(left: 0) == "Left 1 min ago")
    #expect(Countdown.words(left: -1) == "Left 1 min ago")
    #expect(Countdown.words(left: -61) == "Left 2 min ago")
}

@Test func aOneOffTripSaysArriveByNotStarts() throws {
    func untitled(_ name: String) throws -> NextAnswer {
        let data = try Data(contentsOf: answers.appendingPathComponent("\(name).json"))
        var json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        var card = try #require(json["card"] as? [String: Any])
        var journey = try #require(card["journey"] as? [String: Any])
        journey["title"] = nil
        card["journey"] = journey
        json["card"] = card
        return try NextAnswer.decode(JSONSerialization.data(withJSONObject: json))
    }
    let once = try untitled("once-from-home")
    #expect(once.dest?.place == true)
    let title = JourneyText.to(once, try #require(once.card?.journey))
    #expect(title.hasPrefix("To COM 3 · arrive by "), "\(title)")
    let lesson = try untitled("class-bus")
    #expect(lesson.dest?.place == nil)
    let starts = JourneyText.to(lesson, try #require(lesson.card?.journey))
    #expect(starts.hasPrefix("To GEA1000 @ UTown · starts "), "\(starts)")
}

@Test func theReportSheetOffersTheReasonsThatFit() throws {
    let offered = { (name: String) in
        ReportSheet.reasons(fitting: try NextAnswer.decode(Data(contentsOf: answers.appendingPathComponent("\(name).json"))).card?.reasons)
    }
    let all = ["never-came", "times-off", "wrong-stop", "walk-longer", "wrong-class"]
    #expect(try offered("class-bus") == all)
    #expect(try offered("riding") == ["times-off", "wrong-stop", "walk-longer", "wrong-class"], "on the bus there's none to come")
    #expect(try offered("rest") == ["wrong-class"], "a day that's done has no bus or walk")

    var json = try #require(
        try JSONSerialization.jsonObject(with: Data(contentsOf: answers.appendingPathComponent("rest.json"))) as? [String: Any])
    var card = try #require(json["card"] as? [String: Any])
    card.removeValue(forKey: "reasons")
    json["card"] = card
    let older = try NextAnswer.decode(JSONSerialization.data(withJSONObject: json))
    #expect(older.card != nil)
    #expect(older.card?.reasons == nil)
    #expect(ReportSheet.reasons(fitting: older.card?.reasons) == all)
}

@Test func theReportSheetKnowsWhenTimesAreNUSs() throws {
    let card = { (name: String) in try NextAnswer.decode(Data(contentsOf: answers.appendingPathComponent("\(name).json"))).card }
    #expect(try card("class-late")?.fromNus == true)
    #expect(try card("public-wins")?.fromNus == false, "a public bus's times are LTA's")
    #expect(try card("scheduled")?.fromNus == false, "an estimate is ours")
}
