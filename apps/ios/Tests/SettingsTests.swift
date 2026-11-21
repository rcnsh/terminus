import XCTest

@testable import Terminus

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
        var p = doc(#"{"limits":{"placeLabel":24}}"#)
        p.addPlace(label: String(repeating: "b", count: 23) + "🚌", to: "KR-MRT")
        XCTAssertEqual(p.places.map(\.label), [String(repeating: "b", count: 23)])

        XCTAssertEqual(clippedUTF16(String(repeating: "a", count: 59) + "🚌", 60), String(repeating: "a", count: 59))
        XCTAssertEqual(clippedUTF16("ab🚌", 4), "ab🚌")
        XCTAssertEqual(clippedUTF16("Gym", 60), "Gym")
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

    func testClassChangesFollowTheClassNotItsPlace() {
        let seen = doc(
            #"{"trips":[{"day":1,"arriveByMin":500,"to":"A","label":"First"},{"day":1,"arriveByMin":600,"to":"B","label":"Second"},{"day":1,"arriveByMin":700,"to":"C","label":"Third"}]}"#
        )
        let second = seen.classes[1]
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

final class WherePickerTests: XCTestCase {
    func testAStopAndABuildingWithOneCodeAreTwoResults() {
        let stop = WhereItem(code: "COM3", label: "COM3", kind: "stop", detail: nil, goesTo: "COM3")
        let building = WhereItem(code: "COM3", label: "COM3", kind: "building", detail: nil, goesTo: "COM3")
        XCTAssertNotEqual(stop.id, building.id)
        let row = WhereItem(code: "COM3", label: "COM3", kind: "timetable", detail: "CS2030", goesTo: "COM3")
        XCTAssertTrue(stop.isPlace(of: row))
        XCTAssertFalse(building.isPlace(of: row))
    }
}

final class SettingsDevicesTests: XCTestCase {
    private func device(_ json: String) -> Device {
        try! JSONDecoder().decode(Device.self, from: Data(json.utf8))
    }

    func testAWatchIsNamedAWatch() {
        XCTAssertEqual(settingsPlatformName(device(#"{"id":"a","platform":"ios","watch":true}"#)), "Apple Watch")
        XCTAssertEqual(settingsPlatformName(device(#"{"id":"b","platform":"ios","watch":false}"#)), "iPhone")
        XCTAssertEqual(settingsPlatformName(device(#"{"id":"c","platform":"ios"}"#)), "iPhone")
        XCTAssertEqual(settingsPlatformName(device(#"{"id":"d","platform":"android","watch":false}"#)), "Android")
    }
}

private final class FakeProfileServer: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [String: Any]
    private var tag = 1
    private(set) var puts: [[String: Any]] = []
    var refuse: ApiError?

    init(_ profile: [String: Any]) { stored = profile }

    var wire: ProfileWire {
        ProfileWire(
            fetch: { _ in self.locked { (try! JSONSerialization.data(withJSONObject: self.stored), "\(self.tag)") } },
            save: { _, body, ifMatch in
                try self.locked {
                    if let e = self.refuse { throw e }
                    if let ifMatch, ifMatch != "\(self.tag)" { throw ApiError(status: 412, message: "changed") }
                    let p = try JSONSerialization.jsonObject(with: body) as! [String: Any]
                    self.puts.append(p)
                    self.stored = p
                    self.tag += 1
                    return (body, "\(self.tag)")
                }
            })
    }

    func changeElsewhere(_ key: String, _ value: Any) {
        locked {
            stored[key] = value
            tag += 1
        }
    }

    private func locked<T>(_ f: () throws -> T) rethrows -> T {
        lock.lock()
        defer { lock.unlock() }
        return try f()
    }
}

@MainActor final class ProfileSaverTests: XCTestCase {
    private func saver(_ server: FakeProfileServer) -> ProfileSaver {
        let s = ProfileSaver(wire: server.wire, wait: .milliseconds(20))
        s.token = { "t" }
        s.loaded(ProfileDoc(["walkPace": "normal", "homeWalkMin": 5]), tag: "1")
        return s
    }

    func testARunOfEditsIsOneSave() async {
        let server = FakeProfileServer(["walkPace": "normal", "homeWalkMin": 5])
        let s = saver(server)
        s.edit { $0.walkPace = "fast" }
        s.edit { $0.homeWalkMin = 8 }
        XCTAssertEqual(s.doc?.walkPace, "fast")
        try? await Task.sleep(for: .milliseconds(60))
        await s.flush()
        XCTAssertEqual(server.puts.count, 1)
        XCTAssertEqual(server.puts.first?["homeWalkMin"] as? Int, 8)
        XCTAssertFalse(s.saving)
    }

    func testAChangeElsewhereIsKeptAndTheEditsRedoneOnIt() async {
        let server = FakeProfileServer(["walkPace": "normal", "homeWalkMin": 5])
        let s = saver(server)
        server.changeElsewhere("clock", "24")
        s.edit { $0.walkPace = "slow" }
        await s.flush()
        XCTAssertEqual(server.puts.count, 1)
        XCTAssertEqual(server.puts.first?["clock"] as? String, "24")
        XCTAssertEqual(s.doc?.walkPace, "slow")
        XCTAssertEqual(s.doc?.clock, "24")
    }

    func testARefusalPutsBackTheSavedProfileAndSaysWhy() async {
        let server = FakeProfileServer(["walkPace": "normal", "homeWalkMin": 5])
        server.refuse = ApiError(status: 400, message: "walkPace is not allowed")
        let s = saver(server)
        var said: [String] = []
        s.say = { said.append($0) }
        s.edit { $0.walkPace = "fast" }
        await s.flush()
        XCTAssertEqual(s.doc?.walkPace, "normal")
        XCTAssertEqual(said.count, 1)
        XCTAssertTrue(said.first?.contains("walkPace is not allowed") == true)
    }

    func testAnEditWhileSavingIsSavedNextOnWhatWasSaved() async {
        let server = FakeProfileServer(["walkPace": "normal", "homeWalkMin": 5])
        let s = saver(server)
        s.edit { $0.walkPace = "fast" }
        s.sendNow()
        s.edit { $0.homeWalkMin = 9 }
        XCTAssertEqual(s.doc?.walkPace, "fast")
        XCTAssertEqual(s.doc?.homeWalkMin, 9)
        try? await Task.sleep(for: .milliseconds(60))
        await s.flush()
        XCTAssertEqual(server.puts.count, 2)
        XCTAssertEqual(server.puts.last?["walkPace"] as? String, "fast")
        XCTAssertEqual(server.puts.last?["homeWalkMin"] as? Int, 9)
    }

    func testTwoChangesElsewhereInARowStillSave() async {
        let server = FakeProfileServer(["walkPace": "normal", "homeWalkMin": 5])
        let base = server.wire
        let racing = Conflicts(1)
        let wire = ProfileWire(
            fetch: { t in
                let r = try await base.fetch(t)
                if racing.take() { server.changeElsewhere("clock", "24") }
                return r
            },
            save: base.save)
        let s = ProfileSaver(wire: wire, wait: .milliseconds(20))
        s.token = { "t" }
        s.loaded(ProfileDoc(["walkPace": "normal", "homeWalkMin": 5]), tag: "1")
        var said: [String] = []
        s.say = { said.append($0) }
        server.changeElsewhere("dayStartMin", 420)
        s.edit { $0.walkPace = "slow" }
        await s.flush()
        XCTAssertEqual(server.puts.count, 1)
        XCTAssertEqual(s.doc?.walkPace, "slow")
        XCTAssertEqual(s.doc?.clock, "24")
        XCTAssertTrue(said.isEmpty)
    }
}

private final class Conflicts: @unchecked Sendable {
    private let lock = NSLock()
    private var left: Int

    init(_ n: Int) { left = n }

    func take() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard left > 0 else { return false }
        left -= 1
        return true
    }
}
