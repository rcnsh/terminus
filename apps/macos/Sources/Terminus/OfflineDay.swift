import SwiftUI

/// What the menu bar and the popover show when the Mac is offline and the
/// last answer has gone stale: the next thing on the day plan kept from
/// /me/day. The web and Android apps follow the same rule (app/offline.js,
/// OfflineDay.kt), checked against the same cases
/// (apps/api/test/fixtures/offline-day.json).
enum OfflineDay {
    /// A class still counts this long after it starts: late, but still the one to go to.
    static let classGrace: TimeInterval = 15 * 60
    /// A trip home with no end of its own stays up this long.
    static let homeFor: TimeInterval = 60 * 60

    enum Step: String { case leaveBy, leaveNow, home }

    struct Pick {
        let item: DayPlan.Item
        let step: Step
    }

    /// The SGT date (YYYY-MM-DD) at `now`.
    static func sgtDate(_ now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        let c = cal.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The plan's next item at `now` and which line to show; nil when it's another day's or nothing is ahead.
    static func next(_ day: DayPlan?, now: Date) -> Pick? {
        guard let day, day.date == sgtDate(now) else { return nil }
        for item in day.items {
            if item.status == "done" || item.status == "skipped" { continue }
            guard let start = parseISODate(item.startsAt) else { continue }
            if item.kind == "class" {
                if now >= start.addingTimeInterval(classGrace) { continue }
                let leave = item.leave.flatMap { parseISODate($0.at) }
                return Pick(item: item, step: leave.map { now < $0 } == true ? .leaveBy : .leaveNow)
            }
            let end = item.endsAt.flatMap(parseISODate) ?? start.addingTimeInterval(homeFor)
            if now >= end { continue }
            return Pick(item: item, step: .home)
        }
        return nil
    }

    /// What it's for, the headline, and how: worded as the Today list words
    /// them. Always an estimate (it was planned a while ago), so always "~";
    /// the class's start time is there so a "Leave now" after it has started
    /// reads as late, and a trip home says from when.
    struct Lines {
        let head: String
        let big: String
        let how: String?
    }

    static func lines(_ p: Pick) -> Lines {
        let item = p.item
        let start = parseISODate(item.startsAt).map(campusTime) ?? ""
        if p.step == .home { return Lines(head: start, big: item.title, how: nil) }
        // The rest is worked out here: offline, a leave-by planned a while ago
        // is always an estimate, which the line kept from then may not say.
        let leave = item.leave
        let at = leave.flatMap { parseISODate($0.at) }
        let big: String
        if p.step == .leaveBy, let at {
            big = L("Leave by %@", L("~%@", campusTime(at)))
        } else {
            big = L("Leave now")
        }
        let how = leave.map { l in l.svc.map { L("%@ from %@", $0, l.stop ?? item.fromName ?? "") } ?? L("walk") }
        // Capitalised: on a line of its own, not after "Leave by …" as in Today.
        return Lines(head: "\(item.title) · \(L("starts %@", start))", big: big, how: how.map { $0.prefix(1).uppercased() + $0.dropFirst() })
    }

    /// The menu bar's text: as for a class plan ("Leave 09:36", "Leave now"); the plain icon for a trip home.
    static func menuTitle(_ p: Pick) -> String? {
        switch p.step {
        case .leaveBy: return p.item.leave.flatMap { parseISODate($0.at) }.map { L("Leave %@", L("~%@", campusTime($0))) }
        case .leaveNow: return L("Leave now")
        case .home: return nil
        }
    }
}

/// The popover's card while offline: how to get to the plan's next class.
/// The header already says Offline and when to leave; a trip home has no card.
struct OfflineDetail: View {
    let pick: OfflineDay.Pick

    var body: some View {
        if let how = OfflineDay.lines(pick).how {
            Label(how, systemImage: pick.item.leave?.svc == nil ? "figure.walk" : "bus.fill")
                .fontWeight(.semibold)
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
        }
    }
}
