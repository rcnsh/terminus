import XCTest

@testable import Terminus

/// Pull to refresh: the sky's stretch, when letting go asks, what the pill
/// says, and the bus on the horizon. As Android's PullTest, on the same numbers.
final class PullTests: XCTestCase {
    /// Now's horizon on a 393 pt phone, drawn 1.25 times: the card's bus a little way down the road.
    private let width: CGFloat = 393 / 1.25
    private var sign: CGFloat { roadSign(width) }
    private var road: PullScene { PullScene(width: width, sign: sign, home: Pull.roadBus(sign, 0.5)) }

    /// The Buses tab's low hills: no bus of the card's.
    private let hill = PullScene.hill(393)

    private func motion(_ scene: PullScene? = nil, calm: Bool = false) -> PullMotion { PullMotion(scene: scene ?? road, calm: calm) }

    func testTheSkyStretchesLessTheFurtherItGoes() {
        XCTAssertEqual(Pull.rubber(0), 0, accuracy: 0.001)
        // The web's numbers: 170 * (1 - e^(-raw / 200)).
        XCTAssertEqual(Pull.rubber(200), 170 * (1 - exp(-1)), accuracy: 0.01)
        let a = Pull.rubber(50)
        let b = Pull.rubber(100) - a
        XCTAssertTrue((30...50).contains(a))
        XCTAssertLessThan(b, a)
        XCTAssertLessThanOrEqual(Pull.rubber(10_000), Pull.max)
        for raw: CGFloat in [0, 30, 120, 400] { XCTAssertEqual(Pull.unrubber(Pull.rubber(raw)), raw, accuracy: 0.5) }
    }

    func testTheHeaderComesDownALittleAndThePillSitsInTheRoom() {
        XCTAssertEqual(Pull.lead(0), 0, accuracy: 0.001)
        XCTAssertEqual(Pull.lead(100), 12, accuracy: 0.001)
        // Halfway between what's above (14 pt over the room, come down by the lead) and the words at the room's foot.
        let pull: CGFloat = 84
        let room = 34 + pull
        let centre = Pull.pillCentre(above: 14, room: room, pull: pull)
        XCTAssertEqual(centre, (Pull.lead(pull) - 14 + room) / 2, accuracy: 0.001)
        XCTAssertTrue(centre > Pull.lead(pull) - 14 && centre < room)
        // No pill until there's room for it, then all the while it waits.
        XCTAssertEqual(Pull.hintAlpha(20, held: false), 0, accuracy: 0.001)
        XCTAssertEqual(Pull.hintAlpha(44, held: false), 1, accuracy: 0.001)
        XCTAssertEqual(Pull.hintAlpha(0, held: true), 1, accuracy: 0.001)
    }

    func testAnAnswerUnderFifteenSecondsOldIsNotAskedAgain() {
        let now = Date()
        XCTAssertTrue(Pull.shouldFetch(lastOK: nil, now: now))
        XCTAssertFalse(Pull.shouldFetch(lastOK: now.addingTimeInterval(-1), now: now))
        XCTAssertFalse(Pull.shouldFetch(lastOK: now.addingTimeInterval(-14.999), now: now))
        XCTAssertTrue(Pull.shouldFetch(lastOK: now.addingTimeInterval(-15), now: now))
        // A clock set back since: asked again, rather than never.
        XCTAssertTrue(Pull.shouldFetch(lastOK: now.addingTimeInterval(60), now: now))
    }

    func testThePillSaysWhatHappened() {
        Lang.pref = "en"
        XCTAssertEqual(PullHint.pull.words, "Pull to refresh")
        XCTAssertEqual(PullHint.letGo.words, "Let go to refresh")
        XCTAssertEqual(PullHint.done(.updated).words, "Updated just now")
        XCTAssertEqual(PullHint.done(.upToDate(nextInS: 9)).words, "Up to date, next update in 9 s")
        XCTAssertEqual(PullHint.done(.upToDate(nextInS: nil)).words, "Up to date")
        XCTAssertEqual(PullHint.done(.failed).words, "Couldn't update")
        XCTAssertEqual(Pull.minShow(.upToDate(nextInS: nil)), 600)
        XCTAssertEqual(Pull.minShow(.updated), 700)
    }

    func testUpToDateSaysWhenTheNextTimesCome() {
        let now = Date()
        XCTAssertEqual(Pull.inS(now.addingTimeInterval(8.2), now: now), 9)
        XCTAssertEqual(Pull.inS(now.addingTimeInterval(0.03), now: now), 1)
        XCTAssertNil(Pull.inS(nil, now: now), "no timed refresh due")
        XCTAssertNil(Pull.inS(now.addingTimeInterval(-0.001), now: now), "one already past says nothing")
    }

    func testTheHorizonsPlacesAreTheOnesItDraws() {
        // Your stop's sign left of the flag (at 0.76 across), the bus short of it.
        XCTAssertLessThan(sign, width * 0.76 - 6)
        XCTAssertEqual(Pull.roadBus(sign, 0), sign - Pull.shortOfSign, accuracy: 0.5)
        XCTAssertLessThan(Pull.roadBus(sign, 1), Pull.roadBus(sign, 0.5))
        XCTAssertEqual(road.from, road.home)
        XCTAssertEqual(road.rest, road.home)
        // With no bus of the card's: in from off the left, and back to the stop.
        XCTAssertEqual(hill.from, Pull.start)
        XCTAssertEqual(hill.rest, hill.stop)
        // Now's road: the card's bus where it's drawn, the shuttle going by, or none on foot.
        let bus = Road(stop: true, bus: RoadBus(color: 0xFF0000, far: 0.5, live: true), shuttle: false)
        XCTAssertEqual(PullScene.road(width, bus).home, Pull.roadBus(sign, 0.5))
        XCTAssertEqual(PullScene.road(width, Road()).home, shuttleX(width))
        XCTAssertNil(PullScene.road(width, Road(shuttle: false)).home)
    }

    func testTheCardsBusDrivesToTheStopAsTheSkyStretches() {
        XCTAssertEqual(Pull.busX(0, start: road.from, stop: road.stop), road.from, accuracy: 0.001)
        XCTAssertEqual(Pull.busX(1, start: road.from, stop: road.stop), road.stop, accuracy: 0.001)
        XCTAssertEqual(Pull.busX(2, start: road.from, stop: road.stop), road.stop, accuracy: 0.001)
        // Eased: past halfway at half the pull.
        XCTAssertGreaterThan(Pull.busX(0.5, start: road.from, stop: road.stop), (road.from + road.stop) / 2)
        XCTAssertEqual(Pull.progress(Pull.arm), 1, accuracy: 0.001)
        let m = motion()
        m.drag(0.2)
        m.step(1 / 60)
        // It starts where the card had it, so nothing jumps.
        XCTAssertEqual(m.busX, road.home!, accuracy: 0.5)
    }

    func testArmedItTicksOnceAndLettingGoAsks() {
        let m = motion()
        var ticks = 0
        for _ in 0..<40 where m.drag(8) { ticks += 1 }
        XCTAssertTrue(m.armed)
        XCTAssertEqual(m.hint, .letGo)
        XCTAssertTrue(m.lit)
        XCTAssertEqual(ticks, 1)
        // Back up a little and down again: a tick each time it crosses.
        m.drag(-200)
        XCTAssertFalse(m.armed)
        XCTAssertEqual(m.hint, .pull)
        if m.drag(200) { ticks += 1 }
        XCTAssertEqual(ticks, 2)
        XCTAssertTrue(m.release())
        XCTAssertEqual(m.phase, .busy)
        XCTAssertEqual(m.hint, .checking)
        // It waits at the hold while it asks, however long that takes.
        m.run(2_000)
        XCTAssertEqual(m.pull, Pull.hold, accuracy: 1)
        XCTAssertTrue(m.lit)
        XCTAssertNil(m.result)
    }

    func testOnlyATouchThatStartsAtTheTopPulls() {
        let m = motion()
        // Scrolling up into the top and on: the rest of that drag doesn't pull.
        m.touch()
        m.contentScrolled()
        XCTAssertFalse(m.drag(400))
        XCTAssertEqual(m.phase, .idle)
        XCTAssertEqual(m.pull, 0, accuracy: 0.001)
        // A new touch, at the top: it pulls.
        m.touch()
        m.drag(400)
        XCTAssertEqual(m.phase, .drag)
        XCTAssertTrue(m.armed)
        // Pushed back past the top, the content scrolls: down again in the same touch doesn't pull.
        m.drag(-1_000)
        m.contentScrolled()
        m.drag(400)
        XCTAssertEqual(m.phase, .idle)
    }

    func testTheBusBoardsThenDrivesOffAndGoesRoundAgain() {
        let m = motion()
        m.drag(400)
        _ = m.release()
        m.run(300)
        XCTAssertEqual(m.drive, .boarding)
        XCTAssertEqual(m.busX, road.stop, accuracy: 0.001)
        m.run(500)
        XCTAssertEqual(m.drive, .departing)
        XCTAssertGreaterThan(m.busX, road.stop)
        XCTAssertFalse(m.puffs.isEmpty)
        m.run(1_500)
        XCTAssertEqual(m.drive, .looping)
    }

    func testTheAnswerIsSaidThenTheCardsBusComesBackAndItCloses() {
        let m = motion()
        m.drag(400)
        _ = m.release()
        m.run(100)
        m.done(.updated)
        m.run(400)
        XCTAssertEqual(m.phase, .busy)
        m.run(300)
        XCTAssertEqual(m.phase, .shown)
        XCTAssertEqual(m.hint, .done(.updated))
        XCTAssertEqual(m.result, .updated)
        XCTAssertTrue(m.good)
        XCTAssertFalse(m.lit)
        // Said for a second, then the sky closes whether or not the bus is back.
        m.run(800)
        XCTAssertEqual(m.phase, .shown)
        m.run(250)
        XCTAssertEqual(m.phase, .closing)
        // The sky shuts first; the bus drives on home at its own pace, the scene still on the horizon.
        var frames = 0
        while m.pull > 0 && frames < 120 {
            m.step(1 / 60)
            frames += 1
        }
        XCTAssertEqual(m.pull, 0)
        XCTAssertTrue(m.open)
        XCTAssertEqual(m.drive, .back)
        XCTAssertGreaterThan(abs(m.busX - road.home!), 1)
        XCTAssertFalse(m.good)
        m.run(2_000)
        XCTAssertEqual(m.phase, .idle)
        XCTAssertEqual(m.pull, 0, accuracy: 0.001)
        // Back where the card has it.
        XCTAssertEqual(m.busX, road.home!, accuracy: 0.5)
    }

    func testTheBusComesBackToWhereTheNewAnswerPutsIt() {
        let m = motion()
        m.drag(400)
        _ = m.release()
        m.done(.updated)
        m.scene = PullScene(width: width, sign: sign, home: Pull.roadBus(sign, 0.1))
        m.run(3_000)
        XCTAssertEqual(m.phase, .idle)
        XCTAssertEqual(m.busX, Pull.roadBus(sign, 0.1), accuracy: 0.5)
    }

    func testASlowAnswerIsSaidAsSoonAsItsIn() {
        let m = motion()
        m.drag(400)
        _ = m.release()
        m.run(3_000)
        m.done(.failed)
        m.step(1 / 60)
        XCTAssertEqual(m.phase, .shown)
        XCTAssertEqual(m.hint, .done(.failed))
        // Not green: it didn't update.
        XCTAssertFalse(m.good)
    }

    func testLettingGoShortAsksNothing() {
        let m = motion()
        m.drag(40)
        XCTAssertFalse(m.armed)
        XCTAssertFalse(m.release())
        XCTAssertEqual(m.phase, .cancel)
        m.run(1_000)
        XCTAssertEqual(m.phase, .idle)
        XCTAssertEqual(m.pull, 0, accuracy: 0.001)
        XCTAssertNil(m.result)
        XCTAssertNil(m.hint)
        XCTAssertEqual(m.busX, road.home!, accuracy: 0.5)
    }

    func testUpwardTheFingerTakesTheSkyBackFirst() {
        let m = motion()
        m.drag(50)
        XCTAssertEqual(m.takeBack(-80), -50, accuracy: 0.001)
        XCTAssertEqual(m.pull, 0, accuracy: 0.001)
        XCTAssertEqual(m.phase, .idle)
        XCTAssertEqual(m.takeBack(-10), 0, accuracy: 0.001)
    }

    func testOnTheHillsASignGrowsAndABusDrivesInFromTheLeft() {
        let m = motion(hill)
        m.drag(1)
        m.step(1 / 60)
        XCTAssertLessThan(m.busX, 0)
        XCTAssertEqual(m.signGrow, 0, accuracy: 0.001)
        m.drag(400)
        m.step(1 / 60)
        XCTAssertEqual(m.signGrow, 1, accuracy: 0.001)
        XCTAssertEqual(m.busX, hill.stop, accuracy: 0.5)
    }

    func testWithReduceMotionNothingDrivesAndTheSkyEasesBack() {
        // Now: the card's bus stays in its place; only the sign lights.
        let m = motion(calm: true)
        m.drag(400)
        m.step(1 / 60)
        XCTAssertEqual(m.busX, road.home!, accuracy: 0.001)
        XCTAssertEqual(m.alpha, 1, accuracy: 0.001)
        XCTAssertTrue(m.lit)
        _ = m.release()
        m.done(.upToDate(nextInS: nil))
        var lowest = CGFloat.greatestFiniteMagnitude
        for _ in 0..<30 {
            m.step(1 / 60)
            XCTAssertEqual(m.busX, road.home!, accuracy: 0.001)
            XCTAssertEqual(m.bob, 0, accuracy: 0.001)
            lowest = min(lowest, m.pull)
        }
        // Eased down to the hold, never below it.
        XCTAssertGreaterThanOrEqual(lowest, Pull.hold - 0.01)
        m.run(3_000)
        XCTAssertEqual(m.phase, .idle)
        XCTAssertTrue(m.puffs.isEmpty)

        // Buses: one stands at the stop, faded in as the sky opens.
        let h = motion(hill, calm: true)
        h.drag(5)
        h.step(1 / 60)
        XCTAssertEqual(h.alpha, 0, accuracy: 0.001)
        h.drag(400)
        h.step(1 / 60)
        XCTAssertEqual(h.busX, hill.stop, accuracy: 0.001)
        XCTAssertEqual(h.alpha, 1, accuracy: 0.001)
    }
}

extension PullMotion {
    /// Steps `ms` of frames at 60 a second.
    fileprivate func run(_ ms: Int) {
        for _ in 0..<(ms * 60 / 1000) { step(1 / 60) }
    }
}
