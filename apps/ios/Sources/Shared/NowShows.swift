import Foundation

enum NowShows {
    case nearby
    case checking
    case waiting(String)
    case offline(OfflineDay.Lines)
    case dayDone(NextAnswer)
    case journey(NextAnswer, Journey)
    case classPlan(NextAnswer)
    case plain(NextAnswer, old: Bool)

    static func of(
        nearby: Bool, answer a: NextAnswer?, onPlan: Bool, paired: Bool, error: String?, loading: Bool, day: DayPlan?, now: Date
    ) -> NowShows {
        if nearby { return .nearby }
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

    var room: CGFloat {
        switch self {
        case .nearby: 26
        case .dayDone: 72
        default: 34
        }
    }

    func road(now: Date) -> Road {
        if case .journey(_, let j) = self { return Road.of(j, now: now) }
        return Road()
    }
    var road: Road { road(now: ServerClock.now) }
}

extension NextAnswer {
    var plainHeading: String? {
        card?.heading ?? (mode == "nearby" ? L("Nearby") : dest?.why == "gap-home" ? L("%@ · long gap", dest?.label ?? "") : dest?.label)
    }

    var doneSub: String? {
        let upcoming = card?.upcoming
        return upcoming?.off ?? (upcoming == nil && !detail.isEmpty ? detail : nil)
    }
}
