import XCTest

@testable import Terminus

/// The window's width picks the layout at 600 and 800 (ADR 0015), and wide
/// the lists open a page beside them rather than over them.
@MainActor
final class WindowWidthTests: XCTestCase {
    func testTheWidthsAt600And800() {
        // An iPhone, an iPad in a Split View third, an iPad mini, an 11-inch
        // iPad in portrait and landscape, an unfolded iPhone Duo.
        XCTAssertEqual(WindowWidth(402), .narrow)
        XCTAssertEqual(WindowWidth(599.5), .narrow)
        XCTAssertEqual(WindowWidth(600), .medium)
        XCTAssertEqual(WindowWidth(744), .medium)
        XCTAssertEqual(WindowWidth(799), .medium)
        XCTAssertEqual(WindowWidth(800), .wide)
        XCTAssertEqual(WindowWidth(834), .wide)
        XCTAssertEqual(WindowWidth(867), .wide)
        XCTAssertEqual(WindowWidth(1210), .wide)
        XCTAssertFalse(WindowWidth.medium.panes)
        XCTAssertTrue(WindowWidth.wide.panes)
    }

    func testStopsPushesOverTheHomeOnAPhone() {
        let m = BusesModel()
        m.open(.line(svc: "D2", from: nil))
        m.open(.stop("KR-MRT"))
        XCTAssertEqual(m.path, [.line(svc: "D2", from: nil), .stop("KR-MRT")])
        XCTAssertNil(m.chosen)
    }

    func testStopsWideOpensBesideTheHomeInPlaceOfTheOpenPage() {
        let m = BusesModel()
        m.split = true
        XCTAssertNil(m.chosen)
        m.open(.line(svc: "D2", from: nil))
        // A stop opened from the line pushes in the detail pane.
        m.path.append(.stop("KR-MRT"))
        XCTAssertEqual(m.chosen, .line(svc: "D2", from: nil))
        // Another row on the home replaces the pane's pages.
        m.open(.line(svc: "A1", from: nil))
        XCTAssertEqual(m.path, [.line(svc: "A1", from: nil)])
        XCTAssertEqual(m.chosen, .line(svc: "A1", from: nil))
    }

    func testSettingsWideHasItsFirstPageOpenUntilAnotherIsPicked() {
        let m = SettingsModel()
        XCTAssertNil(m.chosen)
        m.split = true
        // Your trips, not the account: a first look shouldn't land on Sign out.
        XCTAssertEqual(m.shown, .trips)
        XCTAssertEqual(m.chosen, .trips)
        m.open(.about)
        m.pagesOver.wrappedValue = [.licences]
        XCTAssertEqual(m.path, [.about, .licences])
        XCTAssertEqual(m.chosen, .about)
        m.open(.trips)
        XCTAssertEqual(m.path, [.trips])
        // A page pushed over the first page, when none was picked, keeps it under.
        m.path = []
        m.pagesOver.wrappedValue = [.licences]
        XCTAssertEqual(m.path, [.trips, .licences])
    }

    func testOnlyAStopShowingAloneBesideTheHomeIsLeftToItsPage() {
        let m = BusesModel()
        m.path = [.stop("UTOWN")]
        // On a phone the home isn't on screen with the page.
        XCTAssertNil(m.stopBeside)
        m.split = true
        XCTAssertEqual(m.stopBeside, "UTOWN")
        // A line pushed over it: the stop's page has stopped refreshing it.
        m.path.append(.line(svc: "D2", from: "UTOWN"))
        XCTAssertNil(m.stopBeside)
        m.path = [.line(svc: "D2", from: nil)]
        XCTAssertNil(m.stopBeside)
    }

    func testSettingsPushesOverTheListOnAPhone() {
        let m = SettingsModel()
        m.open(.about)
        m.open(.licences)
        XCTAssertEqual(m.path, [.about, .licences])
    }
}
