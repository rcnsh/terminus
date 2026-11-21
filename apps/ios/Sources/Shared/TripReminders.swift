import Foundation

enum TripReminders {
    static let soonID = "leave-soon"
    static let nowID = "leave-now"
    static let category = "trip"
    static let quietCategory = "trip-quiet"
    static let skipAction = "skipped"

    enum Step: Equatable {
        case heading
        case over
        case clear
        case schedule(clearFirst: Bool, trip: String, soon: Date?, leaveAt: Date)
    }

    static func step(_ plan: NextAnswer, soonTrip: String?, soonAt lastSoonAt: Date?, dismissed: String? = nil, now: Date) -> Step {
        let card = plan.card
        let phase = card?.phase ?? "idle"
        if card?.gone == true { return .over }
        if phase == "heading" { return .heading }
        if phase != "idle" && phase != "due" { return .over }
        guard card?.remind != false, let trip = tripKey(plan), let soonAt = card?.remindAt.flatMap(parseISODate),
            let leaveAt = plan.leaveAt, leaveAt > now
        else { return .clear }
        let key = soonKey(plan, now: now)
        if key != nil && key == dismissed { return .clear }
        let clearFirst = soonTrip != nil && soonTrip != key
        let soonDone = soonTrip == key && (lastSoonAt.map { $0 <= now } ?? false)
        return .schedule(clearFirst: clearFirst, trip: trip, soon: soonDone ? nil : soonAt, leaveAt: leaveAt)
    }

    static func tripKey(_ plan: NextAnswer) -> String? {
        plan.card?.actions.first?.trip ?? plan.timing?.classAt
    }

    static func soonKey(_ plan: NextAnswer, now: Date) -> String? {
        guard let trip = tripKey(plan) else { return nil }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .campus
        let day = cal.dateComponents([.year, .month, .day], from: plan.leaveAt ?? now)
        return "\(trip)@\(day.year ?? 0)-\(day.month ?? 0)-\(day.day ?? 0)"
    }

    struct Words: Equatable {
        var title: String
        var subtitle: String
        var body: String
    }

    static func words(_ plan: NextAnswer, leaveNow: Bool, firesAt: Date, checked: Date) -> Words {
        let card = plan.card
        let title = leaveNow ? L("Leave now") : card?.leaveBy ?? card?.title ?? plan.label
        let place = [card?.journey?.title ?? card?.heading ?? plan.dest?.label].compactMap { $0 }.first ?? ""
        var body = card?.catchLine ?? card?.catch ?? plan.detail
        if let stale = plan.staleAt, firesAt >= stale {
            body = [body, L("Last checked %@. Times may have changed.", campusTime(checked))].filter { !$0.isEmpty }.joined(separator: "\n")
        }
        return Words(title: title, subtitle: place, body: body)
    }
}
