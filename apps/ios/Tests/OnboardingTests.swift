import CoreLocation
import XCTest

@testable import Terminus

final class SignInCodeTests: XCTestCase {
    func testTypingFillsFromTheLeft() {
        XCTAssertEqual(SignInCode.edit(old: "", new: "a"), "A")
        XCTAssertEqual(SignInCode.edit(old: "A", new: "Ab"), "AB")
        XCTAssertEqual(SignInCode.edit(old: "AB", new: "AB-"), "AB")
        XCTAssertEqual(SignInCode.edit(old: "ABCDEF", new: "ABCDEFG"), "ABCDEF")
        XCTAssertEqual(SignInCode.edit(old: "ABC", new: "AB"), "AB")
    }

    func testAPasteFindsTheCode() {
        // As Android's codeEdit: the last six-character word that could be a code.
        XCTAssertEqual(SignInCode.edit(old: "", new: "Your code is 7KQ2XM"), "7KQ2XM")
        XCTAssertEqual(SignInCode.edit(old: "AB", new: "AB7KQ2XM"), "7KQ2XM")
        XCTAssertEqual(SignInCode.edit(old: "", new: "7KQ 2XM"), "7KQ2XM")
        XCTAssertEqual(SignInCode.edit(old: "", new: "7kq-2xm"), "7KQ2XM")
        // "WITHIN" is six letters but has an I: not a code.
        XCTAssertEqual(SignInCode.edit(old: "", new: "7KQ2XM works within"), "7KQ2XM")
    }

    func testEmails() {
        XCTAssertTrue(SignInCode.looksLikeEmail("you@u.nus.edu"))
        XCTAssertTrue(SignInCode.looksLikeEmail("  you@u.nus.edu "))
        XCTAssertFalse(SignInCode.looksLikeEmail("you@u"))
        XCTAssertFalse(SignInCode.looksLikeEmail("you@nus"))
        XCTAssertFalse(SignInCode.looksLikeEmail("you u@nus.edu"))
        XCTAssertFalse(SignInCode.looksLikeEmail(""))
    }

    func testScannedPairingCodes() {
        let hosts: Set<String> = ["terminus.run", "terminus.rcn.sh"]
        XCTAssertEqual(SignInCode.pairCode(scanned: "https://terminus.run/pair?code=n2nfwd", hosts: hosts), "N2NFWD")
        XCTAssertEqual(SignInCode.pairCode(scanned: "https://terminus.rcn.sh/pair/?code=TEST67", hosts: hosts), "TEST67")
        XCTAssertEqual(SignInCode.pairCode(scanned: "TEST78", hosts: hosts), "TEST78")
        // Someone else's site, another page, or no code: not ours.
        XCTAssertNil(SignInCode.pairCode(scanned: "https://example.com/pair?code=TEST67", hosts: hosts))
        XCTAssertNil(SignInCode.pairCode(scanned: "https://terminus.run/account?code=TEST67", hosts: hosts))
        XCTAssertNil(SignInCode.pairCode(scanned: "https://terminus.run/pair", hosts: hosts))
        XCTAssertNil(SignInCode.pairCode(scanned: "TEST0O", hosts: hosts))
        XCTAssertNil(SignInCode.pairCode(scanned: "hello", hosts: hosts))
    }
}

final class OnboardingTests: XCTestCase {
    func testClockTimes() {
        XCTAssertEqual(setupClock(9 * 60 + 38, hour12: false), "09:38")
        XCTAssertEqual(setupClock(18 * 60 + 36, hour12: false), "18:36")
        let was = Lang.pref
        Lang.pref = "en"
        defer { Lang.pref = was }
        XCTAssertEqual(setupClock(9 * 60 + 38, hour12: true), "9:38 AM")
        XCTAssertEqual(setupClock(10 * 60, hour12: true), "10 AM")
        XCTAssertEqual(setupClock(0, hour12: true), "12 AM")
        XCTAssertEqual(setupClock(12 * 60 + 5, hour12: true), "12:05 PM")
    }

    func testDaysStartOnSunday() {
        let was = Lang.pref
        Lang.pref = "en"
        defer { Lang.pref = was }
        XCTAssertEqual(setupDay(0), "Sun")
        XCTAssertEqual(setupDay(1), "Mon")
        XCTAssertEqual(setupDay(6), "Sat")
    }

    func testNearestStop() throws {
        let json = """
            {"stops":[{"code":"PGP","name":"PGP","lat":1.2913,"lon":103.7805,"services":["A1"]},
                      {"code":"UTOWN","name":"UTown","lat":1.3036,"lon":103.7745,"services":["D2"]},
                      {"code":"NOWHERE","name":"No place","services":[]}],
             "residences":[],"destinations":[],"routes":{}}
            """
        let campus = try JSONDecoder().decode(Campus.self, from: Data(json.utf8))
        XCTAssertEqual(
            OnboardingModel.nearest(campus.stops, to: CLLocationCoordinate2D(latitude: 1.2915, longitude: 103.7807))?.code, "PGP")
        XCTAssertEqual(
            OnboardingModel.nearest(campus.stops, to: CLLocationCoordinate2D(latitude: 1.304, longitude: 103.774))?.code, "UTOWN")
    }

    func testSignInTitles() async {
        await MainActor.run {
            let was = Lang.pref
            Lang.pref = "en"
            defer { Lang.pref = was }
            XCTAssertEqual(SignInModel().title, "Sign in")
            XCTAssertEqual(SignInModel(adding: true).title, "Add your email")
        }
    }
}
