import XCTest

@testable import Terminus

/// Settings' editing of the profile: what's sent back keeps what this
/// version doesn't know, and the rules match Android's (Profile.kt).
final class SettingsProfileTests: XCTestCase {
    private func doc(_ json: String) -> ProfileDoc {
        ProfileDoc(data: Data(json.utf8))!
    }

    func testUnknownFieldsSurviveAnEdit() {
        var p = doc(#"{"home":{"stops":["PGP"]},"walkPace":"normal","future":{"a":1}}"#)
        p.walkPace = "fast"
        let back = try! JSONSerialization.jsonObject(with: p.data) as! [String: Any]
        XCTAssertEqual(back["walkPace"] as? String, "fast")
        XCTAssertEqual((back["future"] as? [String: Any])?["a"] as? Int, 1)
    }

    func testDefaultsAndLimits() {
        var p = doc(#"{"limits":{"places":2,"homeWalkMin":{"min":1,"max":10}}}"#)
        XCTAssertEqual(p.homeWalkMin, 5)
        XCTAssertEqual(p.walkPace, "normal")
        XCTAssertTrue(p.fullBusMargin)
        XCTAssertFalse(p.publicBuses)
        XCTAssertEqual(p.gapHours, 2)
        XCTAssertEqual(p.limits.places, 2)
        p.homeWalkMin = 40
        XCTAssertEqual(p.homeWalkMin, 10)
        p.homeWalkMin = 0
        XCTAssertEqual(p.homeWalkMin, 1)
        p.gapHours = 0
        XCTAssertEqual(p.gapHours, 0.5)
        p.gapHours = 20
        XCTAssertEqual(p.gapHours, 12)
    }

    func testHomeStopsAreUniqueAndAtMostThree() {
        var p = doc("{}")
        p.setHomeStops(["A", "B", "A", "C", "D"])
        XCTAssertEqual(p.homeStops, ["A", "B", "C"])
        p.setHomeStops([])
        XCTAssertEqual(p.homeStops, [])
        XCTAssertTrue(p.json["home"] is NSNull)
    }

    func testPlaceKeys() {
        XCTAssertEqual(placeKey("Gym", taken: []), "gym")
        XCTAssertEqual(placeKey("Gym", taken: ["gym"]), "gym-2")
        XCTAssertEqual(placeKey("Gym", taken: ["gym", "gym-2"]), "gym-3")
        XCTAssertEqual(placeKey("KR MRT!", taken: []), "kr-mrt")
        XCTAssertEqual(placeKey("咖啡", taken: []), "place")
        XCTAssertEqual(placeKey(String(repeating: "a", count: 40), taken: []).count, 24)
    }

    func testRemovePlaceTakesItsUsualTimesAndUndoPutsThemBack() {
        var p = doc(
            #"{"places":[{"key":"mrt","label":"KR MRT","to":"KR-MRT"},{"key":"gym","label":"Gym","to":"UHALL"}],"usual":[{"place":"gym","day":2,"atMin":1080},{"place":"mrt","day":3,"atMin":600}]}"#
        )
        let r = p.removePlace(key: "mrt")
        XCTAssertEqual(r?.label, "KR MRT")
        XCTAssertEqual(p.places.map(\.key), ["gym"])
        XCTAssertEqual(p.usual, [UsualTime(place: "gym", day: 2, atMin: 1080)])
        p.restorePlace(r!)
        XCTAssertEqual(p.places.map(\.key), ["mrt", "gym"])
        XCTAssertEqual(Set(p.usual.map(\.place)), ["gym", "mrt"])
    }

    func testUndoDoesNothingWhenTheStopIsAFavouriteAgain() {
        var p = doc(#"{"places":[{"key":"mrt","label":"KR MRT","to":"KR-MRT"}]}"#)
        let r = p.removePlace(key: "mrt")!
        p.addPlace(label: "MRT", to: "KR-MRT")
        p.restorePlace(r)
        XCTAssertEqual(p.places.map(\.label), ["MRT"])
    }

    func testClassesAreMondayFirstThenByTime() {
        var p = doc(
            #"{"trips":[{"day":0,"arriveByMin":600,"to":"A","label":"Sun"},{"day":1,"arriveByMin":700,"to":"B","label":"Mon late"}],"manual":[{"day":1,"arriveByMin":500,"to":"C","label":"Mon early"}]}"#
        )
        XCTAssertEqual(p.classes.map(\.trip.label), ["Mon early", "Mon late", "Sun"])
        let sunday = p.classes[2]
        XCTAssertTrue(sunday.imported)
        p.setClassStop(imported: sunday.imported, index: sunday.index, to: "Z")
        XCTAssertEqual(p.trips[0].to, "Z")
        p.removeClass(imported: false, index: 0)
        XCTAssertEqual(p.classes.map(\.trip.label), ["Mon late", "Sun"])
    }

    func testAddManualKeepsTheEndOnlyWhenThere() {
        var p = doc("{}")
        p.addManual(ProfileTrip(day: 2, arriveByMin: 540, endMin: nil, to: "UTOWN", label: "Gym", venue: ""))
        let o = (p.json["manual"] as? [[String: Any]])?.first
        XCTAssertNil(o?["endMin"])
        XCTAssertEqual(o?["label"] as? String, "Gym")
    }

    func testNusmodsLinkInASharedSentence() {
        XCTAssertEqual(
            settingsNusmodsLink(in: "My timetable: https://nusmods.com/timetable/sem-1/share?CS2030=LEC:1."),
            "https://nusmods.com/timetable/sem-1/share?CS2030=LEC:1")
        XCTAssertNil(settingsNusmodsLink(in: "no link here"))
    }

    @MainActor func testFeedbackCountsAsTheServerDoes() {
        XCTAssertEqual(SettingsFeedbackPane.length("😀"), 2)
        let long = String(repeating: "😀", count: 600)
        let clipped = SettingsFeedbackPane.clipped(long)
        XCTAssertEqual(SettingsFeedbackPane.length(clipped), 1000)
        XCTAssertEqual(clipped.count, 500)
    }

    func testPairingQRIsMade() {
        XCTAssertNotNil(pairingQR("https://terminus.rcn.sh/pair?code=ABC123"))
    }
}
