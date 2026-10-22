import Foundation
import Testing

@testable import Terminus

/// The API's golden answers, which its own tests pin word for word: a
/// change in the response's shape fails here too, as on Android and the Mac.
private let answers = fixtures.appendingPathComponent("answers")

/// Every golden there is, English and Chinese ("zh/free"), found in the
/// directory: a new one is read without being listed here.
func goldenNames() -> [String] {
    let names = { (sub: String) in
        ((try? FileManager.default.contentsOfDirectory(atPath: answers.appendingPathComponent(sub).path)) ?? [])
            .filter { $0.hasSuffix(".json") }
            .map { (sub.isEmpty ? "" : "\(sub)/") + String($0.dropLast(5)) }
    }
    return (names("") + names("zh")).sorted()
}

/// The stop across the road (or only near), sent beside `stop`.
@Test func aNearbyStopKnowsItsOpposite() throws {
    struct R: Decodable { let stops: [NearbyStop] }
    let data = try Data(contentsOf: answers.appendingPathComponent("nearby-list.json"))
    let foyer = try #require(try JSONDecoder().decode(R.self, from: data).stops.first { $0.stop.code == "PGPR" })
    #expect(foyer.opposite == "PGP")
    #expect(foyer.oppositeAcross == false)
    #expect(foyer.oppositeName == "Prince George's Park")
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
    if (sent["journey"] as? [String: Any])?["change"] is [String: Any] { #expect(card.journey?.change != nil, "journey.change") }
    if (sent["ride"] as? [String: Any])?["change"] is [String: Any] { #expect(card.ride?.change != nil, "ride.change") }
    #expect(card.actions.count == (sent["actions"] as? [Any])?.count ?? 0, "card.actions")
    #expect(a.places.count == (json["places"] as? [Any])?.count ?? 0, "places")
}

/// What VoiceOver reads for each card: whole sentences, never the
/// shorthand drawn on screen.
@Test(arguments: goldenNames())
func everyGoldenIsSpokenInSentences(name: String) throws {
    let data = try Data(contentsOf: answers.appendingPathComponent("\(name).json"))
    guard let a = try? NextAnswer.decode(data), a.card != nil else { return }
    let said = Spoken.summary(a, now: parseISODate(a.asOf ?? "") ?? Date(), withHead: true)
    #expect(!said.isEmpty, "\(name) says something")
    #expect(!said.contains(" · "), "\(name): \(said)")
}
