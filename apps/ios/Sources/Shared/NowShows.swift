import Foundation

/// What Now shows, worked out once a second from what's there: on the
/// phone its top goes up in the sky and the rest on the ground under the
/// horizon; the watch shows the same cases in the same order.
enum NowShows {
    case nearby
    /// No answer yet and one on its way: the card's shape in bars.
    case checking
    /// No answer yet, and none coming: "No answer yet".
    case waiting(String)
    /// Offline with the plan's answer stale: the next thing on the kept day plan.
    case offline(OfflineDay.Lines)
    /// Nothing to catch: the day's done, a free day, or you're there.
    case dayDone(NextAnswer)
    /// A trip by bus or on foot, in the card style chosen in Settings.
    case journey(NextAnswer, Journey)
    case classPlan(NextAnswer)
    /// Anything else, or a card past its staleAt (`old`), its times dimmed.
    case plain(NextAnswer, old: Bool)

    /// `answer` for the view chosen (`onPlan`: the timetable's), with the last
    /// fetch's `error`, whether one is under way, and the day plan kept for offline.
    static func of(
        nearby: Bool, answer a: NextAnswer?, onPlan: Bool, paired: Bool, error: String?, loading: Bool, day: DayPlan?, now: Date
    ) -> NowShows {
        if nearby { return .nearby }
        // The last refresh failed: the day plan kept for it stands in for a stale answer.
        if onPlan, paired, error != nil, !loading, a == nil || a!.isOld(at: now), let pick = OfflineDay.next(day, now: now) {
            return .offline(OfflineDay.lines(pick))
        }
        guard let a else { return loading || error == nil ? .checking : .waiting(L("No answer yet")) }
        if a.mode == "rest" || a.isFree || a.arrived { return .dayDone(a) }
        let old = a.isOld(at: now)
        if let j = a.card?.journey, !old { return .journey(a, j) }
        if a.isClassPlan && !old { return .classPlan(a) }
        return .plain(a, old: old)
    }

    /// The room above the words, for the stars and the moon at night.
    var room: CGFloat {
        switch self {
        case .nearby: 26
        case .dayDone: 72
        default: 34
        }
    }

    /// What's on the horizon's road.
    func road(now: Date) -> Road {
        if case .journey(_, let j) = self { return Road.of(j, now: now) }
        return Road()
    }
    var road: Road { road(now: ServerClock.now) }
}

extension NextAnswer {
    /// Over a plain card: the server's heading ("Going to KR MRT"), else where it's for.
    var plainHeading: String? {
        card?.heading ?? (mode == "nearby" ? L("Nearby") : dest?.why == "gap-home" ? L("%@ · long gap", dest?.label ?? "") : dest?.label)
    }

    /// Under a day that's done: where the next class is off from, else the detail when there's no next class.
    var doneSub: String? {
        let upcoming = card?.upcoming
        return upcoming?.off ?? (upcoming == nil && !detail.isEmpty ? detail : nil)
    }
}
