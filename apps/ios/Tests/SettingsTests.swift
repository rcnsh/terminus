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
        XCTAssertTrue(p.preferBus)
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

    func testLabelsAreCutAsTheServerCountsThem() {
        // The server counts UTF-16 units: an emoji is two, so 23 letters and
        // one would be 25, over the 24 a favourite's name may have, and refused.
        var p = doc(#"{"limits":{"placeLabel":24}}"#)
        p.addPlace(label: String(repeating: "b", count: 23) + "🚌", to: "KR-MRT")
        XCTAssertEqual(p.places.map(\.label), [String(repeating: "b", count: 23)])

        // A class's name: 59 letters and an emoji is 61 of the 60.
        XCTAssertEqual(clippedUTF16(String(repeating: "a", count: 59) + "🚌", 60), String(repeating: "a", count: 59))
        XCTAssertEqual(clippedUTF16("ab🚌", 4), "ab🚌")
        XCTAssertEqual(clippedUTF16("Gym", 60), "Gym")
        // A flag is one character of four units: whole or not at all.
        XCTAssertEqual(clippedUTF16("SG 🇸🇬", 5), "SG ")
    }

    func testClassesAreMondayFirstThenByTime() {
        var p = doc(
            #"{"trips":[{"day":0,"arriveByMin":600,"to":"A","label":"Sun"},{"day":1,"arriveByMin":700,"to":"B","label":"Mon late"}],"manual":[{"day":1,"arriveByMin":500,"to":"C","label":"Mon early"}]}"#
        )
        XCTAssertEqual(p.classes.map(\.trip.label), ["Mon early", "Mon late", "Sun"])
        let sunday = p.classes[2]
        XCTAssertTrue(sunday.imported)
        p.setClassStop(sunday, to: "Z")
        XCTAssertEqual(p.trips[0].to, "Z")
        p.removeClass(p.classes[0])
        XCTAssertEqual(p.classes.map(\.trip.label), ["Mon late", "Sun"])
        XCTAssertFalse(p.missed)
    }

    /// A change made again on a newer profile (after a 412) finds its class
    /// where it moved to, and never changes the one now at its old place.
    func testClassChangesFollowTheClassNotItsPlace() {
        let seen = doc(
            #"{"trips":[{"day":1,"arriveByMin":500,"to":"A","label":"First"},{"day":1,"arriveByMin":600,"to":"B","label":"Second"},{"day":1,"arriveByMin":700,"to":"C","label":"Third"}]}"#
        )
        let second = seen.classes[1]
        // Another device removed the first class meanwhile.
        var newer = doc(
            #"{"trips":[{"day":1,"arriveByMin":600,"to":"B","label":"Second"},{"day":1,"arriveByMin":700,"to":"C","label":"Third"}]}"#)
        newer.setClassStop(second, to: "Z")
        XCTAssertEqual(newer.trips.map(\.to), ["Z", "C"])
        newer.removeClass(second)
        XCTAssertEqual(newer.trips.map(\.label), ["Third"])
        XCTAssertFalse(newer.missed)
    }

    func testAChangeToAClassThatIsGoneChangesNothing() {
        let seen = doc(
            #"{"trips":[{"day":1,"arriveByMin":500,"to":"A","label":"First"},{"day":1,"arriveByMin":600,"to":"B","label":"Second"}]}"#)
        let first = seen.classes[0]
        var newer = doc(#"{"trips":[{"day":1,"arriveByMin":600,"to":"B","label":"Second"}]}"#)
        newer.setClassStop(first, to: "Z")
        newer.removeClass(first)
        XCTAssertEqual(newer.trips.map(\.to), ["B"])
        XCTAssertTrue(newer.missed)
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

    /// The card styles' sample is the server's answer shape, so Now's card can draw it.
    @MainActor func testCardStyleSampleIsATripByBus() throws {
        let now = Date()
        let a = try XCTUnwrap(SettingsCardSample.answer(now))
        let j = try XCTUnwrap(a.card?.journey)
        XCTAssertEqual(j.bus?.svc, "D2")
        XCTAssertEqual(j.backup?.svc, "A1")
        XCTAssertTrue(j.live)
        XCTAssertEqual(JourneyText.leaveTime(a, j, now: now), L("%@ min", "4"))
        XCTAssertEqual(JourneyText.backup(a, j), L("Or %@ at %@ from %@", "A1", j.backup!.board, "PGP"))
    }
}

/// The where picker's results: a stop and a building may share a code.
final class WherePickerTests: XCTestCase {
    func testAStopAndABuildingWithOneCodeAreTwoResults() {
        let stop = WhereItem(code: "COM3", label: "COM3", kind: "stop", detail: nil, goesTo: "COM3")
        let building = WhereItem(code: "COM3", label: "COM3", kind: "building", detail: nil, goesTo: "COM3")
        XCTAssertNotEqual(stop.id, building.id)
        // A class at the COM3 stop: the stop is that row, the building isn't.
        let row = WhereItem(code: "COM3", label: "COM3", kind: "timetable", detail: "CS2030", goesTo: "COM3")
        XCTAssertTrue(stop.isPlace(of: row))
        XCTAssertFalse(building.isPlace(of: row))
    }
}
