import SwiftUI

enum OfflineDay {
    static let classGrace: TimeInterval = 15 * 60
    static let homeFor: TimeInterval = 60 * 60

    enum Step: String { case leaveBy, leaveNow, home }

    struct Pick {
        let item: DayPlan.Item
        let step: Step
    }

    static func sgtDate(_ now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
        let c = cal.dateComponents([.year, .month, .day], from: now)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

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

    struct Lines {
        let head: String
        let big: String
        let how: String?
    }

    static func lines(_ p: Pick) -> Lines {
        let item = p.item
        let start = parseISODate(item.startsAt).map(campusTime) ?? ""
        if p.step == .home { return Lines(head: start, big: item.title, how: nil) }
        let leave = item.leave
        let at = leave.flatMap { parseISODate($0.at) }
        let big: String
        if p.step == .leaveBy, let at {
            big = L("Leave by %@", L("~%@", campusTime(at)))
        } else {
            big = L("Leave now")
        }
        let how = leave.map { l in l.svc.map { L("%@ from %@", $0, l.stop ?? item.fromName ?? "") } ?? L("walk") }
        return Lines(
            head: "\(item.title) · \(L("starts %@", start))", big: big, how: how.map { $0.prefix(1).uppercased() + $0.dropFirst() })
    }

    static func menuTitle(_ p: Pick) -> String? {
        switch p.step {
        case .leaveBy: return p.item.leave.flatMap { parseISODate($0.at) }.map { L("Leave %@", L("~%@", campusTime($0))) }
        case .leaveNow: return L("Leave now")
        case .home: return nil
        }
    }
}

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
