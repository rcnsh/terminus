import Foundation

/// When to leave, as local notifications: a heads-up at the card's
/// `remindAt`, and "Leave now" at the leave-by. The server decides which
/// trips get one (no `remindAt`, no reminder) and words them. They're
/// scheduled ahead from each answer, so they go on time with the app closed;
/// a later answer moves them. As the Mac's LeaveNotifier, with Android's
/// "Not going" button. This is the choice, apart from the phone so it can be
/// tested; TripSync acts on it.
enum TripReminders {
    static let soonID = "leave-soon"
    static let nowID = "leave-now"
    /// The notifications' category: the card's "Not going" button.
    static let category = "trip"
    static let skipAction = "skipped"

    enum Step: Equatable {
        /// Past the leave-by: the heads-up goes, "Leave now" stays up.
        case heading
        /// At the stop, on the bus, missed, there, not going, or the bus gone
        /// with nothing known: every reminder goes.
        case over
        /// No reminder for this plan: the leave reminders go.
        case clear
        /// Clear the last trip's reminders first if `clearFirst`; then the
        /// heads-up at `soon` (nil: it has gone for this trip already) and
        /// "Leave now" at `leaveAt`.
        case schedule(clearFirst: Bool, trip: String, soon: Date?, leaveAt: Date)
    }

    /// `soonTrip` and `soonAt` are the trip the heads-up was last scheduled
    /// for, and when. `now` is on the server's clock.
    static func step(_ plan: NextAnswer, soonTrip: String?, soonAt lastSoonAt: Date?, now: Date) -> Step {
        let card = plan.card
        let phase = card?.phase ?? "idle"
        // The bus gone with nothing known: you may be on it, so no "Leave now".
        if card?.gone == true { return .over }
        if phase == "heading" { return .heading }
        if phase != "idle" && phase != "due" { return .over }
        guard card?.remind != false, let trip = tripKey(plan), let soonAt = card?.remindAt.flatMap(parseISODate),
            let leaveAt = plan.leaveAt, leaveAt > now
        else { return .clear }
        let clearFirst = soonTrip != nil && soonTrip != trip
        // The heads-up goes once per trip: once it has gone, a leave-by that
        // moves later doesn't bring it back.
        let soonDone = soonTrip == trip && (lastSoonAt.map { $0 <= now } ?? false)
        return .schedule(clearFirst: clearFirst, trip: trip, soon: soonDone ? nil : soonAt, leaveAt: leaveAt)
    }

    /// The trip a notification is about: the key the card's buttons carry, else when the class starts.
    static func tripKey(_ plan: NextAnswer) -> String? {
        plan.card?.actions.first?.trip ?? plan.timing?.classAt
    }

    /// The heads-up's words: the leave-by, the bus to catch, and where to.
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
        // Going off after the times in it have gone stale (no newer answer
        // since): kept, as a late heads-up beats none, but it says so.
        if let stale = plan.staleAt, firesAt >= stale {
            body = [body, L("Last checked %@. Times may have changed.", campusTime(checked))].filter { !$0.isEmpty }.joined(separator: "\n")
        }
        return Words(title: title, subtitle: place, body: body)
    }
}
