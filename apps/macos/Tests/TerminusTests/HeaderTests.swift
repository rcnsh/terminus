import Foundation
import Testing
@testable import Terminus

/// The header's countdowns, which tick on the Mac between refreshes.
private let at = Date(timeIntervalSince1970: 1_790_000_000)

@Test func theLastPartOfASecondIsStillToCome() {
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(-0.5)) == "Leaves in 1 s")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(-0.9)) == "Leaves in 1 s")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(-45)) == "Leaves in 45 s")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(-252)) == "Leaves in 4 min 12 s")
}

@Test func aBusThatHasGoneLeftAtLeastAMinuteAgo() {
    #expect(Header.countdown(to: at, now: at) == "Left 1 min ago")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(0.5)) == "Left 1 min ago")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(30)) == "Left 1 min ago")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(61)) == "Left 2 min ago")
}

@Test func aGuessCountsInMinutes() {
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(-45), minutes: true) == "Leaves in under a minute")
    #expect(Header.countdown(to: at, now: at.addingTimeInterval(-270), minutes: true) == "Leaves in 5 min")
}

/// As the phone's "Leave in 45 s": seconds alone under a minute, not "0 min 45 s".
@Test func theLeaveByCountsDownAsOnThePhone() {
    #expect(Header.leaveIn(45) == "in 45 s")
    #expect(Header.leaveIn(65) == "in 1 min 5 s")
    #expect(Header.leaveIn(150) == "in 3 min")
    #expect(Header.secondsLeft(to: at, now: at.addingTimeInterval(-0.5)) == 1)
    #expect(Header.secondsLeft(to: at, now: at) == nil)
}
