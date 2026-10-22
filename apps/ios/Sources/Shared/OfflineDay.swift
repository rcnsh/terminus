import Foundation

/// What Now and the widgets show offline once the last answer has gone
/// stale: the next thing on the day plan kept from /me/day. Android, the web
/// and the Mac follow the same rule, checked against the same cases
/// (fixtures/offline-day.json).
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

    static func sgtDate(_ now: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .campus
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: now)
    }

    /// The plan's next item at `now` and which line to show; nil when it's another day's or nothing is ahead.
    static func next(_ day: DayPlan?, now: Date) -> Pick? {
        guard let day, day.date == sgtDate(now) else { return nil }
        for item in day.items where item.status != "done" && item.status != "skipped" {
            guard let starts = item.starts else { continue }
            if item.kind == "class" {
                if now >= starts.addingTimeInterval(classGrace) { continue }
                let leave = item.leave.flatMap { parseISODate($0.at) }
                return Pick(item: item, step: leave.map { now < $0 } == true ? .leaveBy : .leaveNow)
            }
            let end = item.endsAt.flatMap(parseISODate) ?? starts.addingTimeInterval(homeFor)
            if now >= end { continue }
            return Pick(item: item, step: .home)
        }
        return nil
    }

    /// When [next] next gives something else, for a redraw then.
    static func nextChange(_ day: DayPlan?, now: Date) -> Date? {
        guard let day, day.date == sgtDate(now) else { return nil }
        let marks = day.items.filter { $0.status != "done" && $0.status != "skipped" }.flatMap { item -> [Date] in
            guard let starts = item.starts else { return [] }
            if item.kind == "class" {
                return [item.leave.flatMap { parseISODate($0.at) }, starts.addingTimeInterval(classGrace)].compactMap { $0 }
            }
            return [item.endsAt.flatMap(parseISODate) ?? starts.addingTimeInterval(homeFor)]
        }
        return marks.filter { $0 > now }.min()
    }

    /// What it's for, the headline, and how: always an estimate (it was
    /// planned a while ago), so always "~"; the class's start is there so a
    /// "Leave now" after it has started reads as late.
    struct Lines: Equatable {
        let head: String
        let big: String
        let how: String?
    }

    static func lines(_ p: Pick) -> Lines {
        let item = p.item
        let starts = item.starts.map(campusTime) ?? ""
        if p.step == .home { return Lines(head: starts, big: item.title, how: nil) }
        let at = item.leave.flatMap { parseISODate($0.at) }
        let big = p.step == .leaveBy && at != nil ? L("Leave by %@", L("~%@", campusTime(at!))) : L("Leave now")
        var how: String?
        if let svc = item.leave?.svc {
            how = L("%@ from %@", svc, item.leave?.stop ?? item.fromName ?? "")
        } else if at != nil {
            how = L("walk")
        }
        // On a line of its own, not after "Leave by …" as in Today: capitalised.
        let first = how.map { $0.prefix(1).uppercased(with: Lang.locale) + $0.dropFirst() }
        return Lines(head: "\(item.serverTitle ?? item.label) · \(L("starts %@", starts))", big: big, how: first)
    }
}
