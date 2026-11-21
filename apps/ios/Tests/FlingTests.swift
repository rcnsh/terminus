import XCTest

@testable import Terminus

final class FlingTests: XCTestCase {
    func testDownFollowsTheFingerAndUpGivesLessAndLess() {
        XCTAssertEqual(Fling.rubber(0, limit: 22), 0)
        XCTAssertEqual(Fling.rubber(80, limit: 22), 80)
        let a = -Fling.rubber(-20, limit: 22)
        let b = -Fling.rubber(-40, limit: 22) - a
        XCTAssertGreaterThan(a, 0)
        XCTAssertLessThan(a, 20)
        XCTAssertLessThan(b, a)
        XCTAssertLessThan(-Fling.rubber(-10_000, limit: 22), 22)
    }

    func testUpTheDrawnSpeedSlowsAsTheGiveDoes() {
        XCTAssertEqual(Fling.rubberSpeed(500, at: 30, limit: 22), 500)
        XCTAssertEqual(Fling.rubberSpeed(-400, at: 0, limit: 22), -400)
        XCTAssertEqual(Fling.rubberSpeed(-400, at: -22, limit: 22), -100, accuracy: 0.001)
        let dy: CGFloat = -40
        let slope = (Fling.rubber(dy + 0.01, limit: 22) - Fling.rubber(dy - 0.01, limit: 22)) / 0.02
        XCTAssertEqual(Fling.rubberSpeed(1, at: dy, limit: 22), slope, accuracy: 0.001)
    }

    func testAFlickCarriesOnTheWayItWasGoing() {
        XCTAssertEqual(Fling.project(0), 0)
        XCTAssertEqual(Fling.project(1_500), 148.5, accuracy: 0.1)
        XCTAssertEqual(Fling.project(-1_500), -148.5, accuracy: 0.1)
        XCTAssertLessThan(Fling.project(100), 10)
    }

    func testTheSpringStartsAtTheFingersSpeed() {
        XCTAssertEqual(Fling.relative(speed: 600, from: 100, to: 400), 2, accuracy: 0.001)
        XCTAssertEqual(Fling.relative(speed: -300, from: 100, to: 400), -1, accuracy: 0.001)
        XCTAssertEqual(Fling.relative(speed: 900, from: 0.5, to: 0), 0)
        XCTAssertEqual(Fling.relative(speed: 100_000, from: 0, to: 100), 20)
    }
}
