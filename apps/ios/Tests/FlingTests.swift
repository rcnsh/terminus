import XCTest

@testable import Terminus

/// The hand-made drags' numbers: the map sheet's give past its end, where a
/// flick on Today's rows is heading, and the spring that carries on at the
/// finger's speed.
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
        // At the start of the give it moves with the finger; 22 pt up, at a quarter of its speed.
        XCTAssertEqual(Fling.rubberSpeed(-400, at: 0, limit: 22), -400)
        XCTAssertEqual(Fling.rubberSpeed(-400, at: -22, limit: 22), -100, accuracy: 0.001)
        // It matches the slope of `rubber` itself.
        let dy: CGFloat = -40
        let slope = (Fling.rubber(dy + 0.01, limit: 22) - Fling.rubber(dy - 0.01, limit: 22)) / 0.02
        XCTAssertEqual(Fling.rubberSpeed(1, at: dy, limit: 22), slope, accuracy: 0.001)
    }

    func testAFlickCarriesOnTheWayItWasGoing() {
        XCTAssertEqual(Fling.project(0), 0)
        // A quick flick (1,500 pt/s) carries about 150 pt: past a row's 140 pt reach from almost anywhere.
        XCTAssertEqual(Fling.project(1_500), 148.5, accuracy: 0.1)
        XCTAssertEqual(Fling.project(-1_500), -148.5, accuracy: 0.1)
        // A slow let-go barely moves.
        XCTAssertLessThan(Fling.project(100), 10)
    }

    func testTheSpringStartsAtTheFingersSpeed() {
        // 600 pt/s with 300 pt to go: twice the distance left a second.
        XCTAssertEqual(Fling.relative(speed: 600, from: 100, to: 400), 2, accuracy: 0.001)
        // Moving away from where it's going: a negative start.
        XCTAssertEqual(Fling.relative(speed: -300, from: 100, to: 400), -1, accuracy: 0.001)
        // Next to no distance left, or a wild speed: nothing silly.
        XCTAssertEqual(Fling.relative(speed: 900, from: 0.5, to: 0), 0)
        XCTAssertEqual(Fling.relative(speed: 100_000, from: 0, to: 100), 20)
    }
}
