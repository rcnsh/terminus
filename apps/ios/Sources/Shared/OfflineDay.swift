import Foundation

enum OfflineDay {
    static let classGrace: TimeInterval = 15 * 60
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
        let first = how.map { $0.prefix(1).uppercased(with: Lang.locale) + $0.dropFirst() }
        return Lines(head: "\(item.title) · \(L("starts %@", starts))", big: big, how: first)
    }
}
