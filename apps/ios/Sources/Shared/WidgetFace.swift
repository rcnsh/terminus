import Foundation

enum WidgetMode: Hashable, Sendable {
    case timetable
    case nearby
    case to(id: String, label: String)

    var id: String {
        switch self {
        case .timetable: "plan"
        case .nearby: "nearby"
        case .to(let id, _): id
        }
    }

    var label: String {
        switch self {
        case .timetable: L("Timetable")
        case .nearby: L("Nearby")
        case .to(_, let label): label
        }
    }

    static func of(id: String?, label: String?) -> WidgetMode {
        guard let id, id != "plan" else { return .timetable }
        if id == "nearby" { return .nearby }
        if id.hasPrefix("place:") || id.hasPrefix("stop:"), let label { return .to(id: id, label: label) }
        return .timetable
    }

    var target: Target? {
        guard case .to(let id, let label) = self else { return nil }
        if id.hasPrefix("place:") { return .place(key: String(id.dropFirst(6))) }
        return .code(String(id.dropFirst(5)), label: label)
    }

    var link: URL {
        switch self {
        case .timetable: return URL(string: "terminus://plan")!
        case .nearby: return URL(string: "terminus://nearby")!
        case .to(let id, let label):
            var c = URLComponents()
            c.scheme = "terminus"
            if id.hasPrefix("place:") {
                c.host = "place"
                c.path = "/" + id.dropFirst(6)
            } else {
                c.host = "to"
                c.path = "/" + id.dropFirst(5)
                c.queryItems = [URLQueryItem(name: "label", value: label), URLQueryItem(name: "k", value: WidgetStore.linkKey)]
            }
            return c.url ?? URL(string: "terminus://plan")!
        }
    }

    static let keep: TimeInterval = 30 * 60
    static let nearbyOld: TimeInterval = 180
    static let refetch: TimeInterval = 60

    static func effective(_ chosen: WidgetMode, at chosenAt: Date?, plan: NextAnswer?, rowShown: Bool, now: Date) -> WidgetMode {
        guard chosen != .timetable, rowShown, let chosenAt else { return .timetable }
        if now.timeIntervalSince(chosenAt) > keep { return .timetable }
        let dueAt = plan?.card?.remindAt.flatMap(parseISODate) ?? plan?.leaveAt
        if let dueAt, dueAt > chosenAt, dueAt <= now, TripPrefs.tripPhases.contains(plan?.phase ?? "") { return .timetable }
        return chosen
    }

    static func chips(places: [Place], added: [(code: String, label: String)], width: CGFloat) -> [WidgetMode] {
        var all: [WidgetMode] = [.timetable, .nearby] + places.map { .to(id: "place:\($0.key)", label: $0.label) }
        for a in added where !all.contains(where: { $0.label.caseInsensitiveCompare(a.label) == .orderedSame }) {
            all.append(.to(id: "stop:\(a.code)", label: a.label))
        }
        let newest = added.first.flatMap { a in all.first { $0.id == "stop:\(a.code)" } }
        return pick(all, newest: newest, width: width)
    }

    static let maxButtons = 6

    static func pick(_ all: [WidgetMode], newest: WidgetMode?, width: CGFloat) -> [WidgetMode] {
        func fits(_ m: [WidgetMode]) -> Bool { fitting(m.map(\.label), width: width) == m.count }
        let shown = Array(all.prefix(min(fitting(all.map(\.label), width: width), maxButtons)))
        if shown.count < 2 { return [] }
        guard let newest, !shown.contains(newest) else { return shown }
        var head = shown.count > 2 ? Array(shown.dropLast()) : shown
        while head.count > 2 && !fits(head + [newest]) { head.removeLast() }
        return fits(head + [newest]) ? head + [newest] : shown
    }

    static func fitting(_ labels: [String], width: CGFloat) -> Int {
        var used: CGFloat = 0
        for (i, l) in labels.enumerated() {
            let text = l.unicodeScalars.reduce(CGFloat(0)) { $0 + ($1.value >= 0x2E80 ? 13 : 7.2) }
            used += (i > 0 ? 6 : 0) + 24 + text
            if used > width { return i }
        }
        return labels.count
    }
}

struct WidgetLeg: Equatable {
    var svc: String?
    var color: String?
    var paid = false
    var text: String
}

struct WidgetPill: Equatable {
    var text: String
    var good: Bool
}

struct WidgetTile: Equatable {
    var label: String
    var title: String
    var place: String?
}

struct WidgetFace {
    var heading: String?
    var headline: String
    var accent: String?
    var late = false
    var dim = false
    var sub: String?
    var pill: WidgetPill?
    var leg: WidgetLeg?
    var road = Road()
    var tile: WidgetTile?
    var journey: Journey?

    var big: String? { accent.flatMap { !$0.isEmpty && headline.contains($0) ? $0 : nil } }

    var bigLabel: String? {
        guard let big else { return nil }
        let rest = headline.replacingOccurrences(of: big, with: "").trimmingCharacters(in: CharacterSet(charactersIn: " ,·~约"))
        return rest.isEmpty ? nil : rest
    }

    var bigFirst: Bool {
        guard let big else { return false }
        let h = headline.trimmingCharacters(in: CharacterSet(charactersIn: " ~约"))
        return h.hasPrefix(big)
    }

    static let updating = "Updating…"

    static func of(paired: Bool, mode: WidgetMode, answer: NextAnswer?, error: String?, offline: OfflineDay.Pick?, now: Date) -> WidgetFace
    {
        if !paired { return WidgetFace(headline: "terminus", sub: error ?? L("Open terminus to sign in")) }
        let problem = error.map { $0 == updating ? L("Updating…") : $0 }
        if let offline {
            let lines = OfflineDay.lines(offline)
            return WidgetFace(heading: L("Offline") + " · " + lines.head, headline: lines.big, sub: lines.how)
        }
        guard let answer else {
            return WidgetFace(heading: mode == .timetable ? nil : mode.label, headline: problem ?? L("Loading…"), sub: L("Tap to refresh"))
        }
        let old = isOld(answer, now: now)
        let card = answer.card
        let ride = card?.phase == "riding" ? card?.ride : nil
        let journey = card?.journey
        if answer.arrived || answer.mode == "rest" || answer.isFree {
            let next = card?.upcoming
            return WidgetFace(
                heading: card?.phaseText,
                headline: answer.label,
                sub: problem ?? (next == nil && !answer.detail.isEmpty ? answer.detail : nil),
                tile: next.map { WidgetTile(label: $0.when, title: $0.title, place: $0.where.isEmpty ? nil : $0.where) }
            )
        }
        if let ride {
            let arrive = campusTime(ride.arriveAt)
            let color = journey?.bus.flatMap { $0.svc == ride.svc ? $0.color : nil }
            let heading = [card?.phaseText, answer.dest?.label].compactMap { $0 }.joined(separator: " · ")
            return WidgetFace(
                heading: heading.isEmpty ? nil : heading,
                headline: L("Off at %@ %@", ride.stops.last!.name, arrive),
                accent: arrive,
                sub: problem ?? answer.timing?.text,
                leg: WidgetLeg(svc: ride.svc, color: color ?? "#24211e", text: ride.nextText(at: now)),
                road: Road(
                    stop: true, bus: RoadBus(color: color.flatMap(hexRGB) ?? 0x24211E, far: 1 - ride.progress(at: now), live: true),
                    shuttle: false)
            )
        }
        if let journey, !old { return trip(answer, journey, problem: problem, now: now) }
        if answer.isClassPlan {
            let heading = [card?.phaseText, answer.dest?.label, answer.classAt.map(answer.startsAt)].compactMap { $0 }
                .joined(separator: " · ")
            return WidgetFace(
                heading: heading.isEmpty ? nil : heading,
                headline: answer.leaveHeadline(now: now) ?? answer.title,
                late: answer.leaveLate && !old,
                dim: old,
                sub: problem ?? (old ? L("Times may be out of date · tap ↻ to refresh") : card?.catchLine)
            )
        }
        let heading = [card?.phaseText, card?.heading ?? answer.dest?.label ?? (answer.mode == "nearby" ? L("Nearby") : nil)].compactMap {
            $0
        }.joined(separator: " · ")
        return WidgetFace(
            heading: heading.isEmpty ? nil : heading,
            headline: answer.title,
            dim: old,
            sub: problem ?? (old ? L("Times may be out of date · tap ↻ to refresh") : answer.detail),
            leg: old ? nil : answer.leaveText(now: now).map { WidgetLeg(text: $0) }
        )
    }

    private static func trip(_ a: NextAnswer, _ j: Journey, problem: String?, now: Date) -> WidgetFace {
        let bus = j.bus
        let headline = a.leaveHeadline(now: now) ?? L("Leave now")
        let leg: WidgetLeg?
        if let bus {
            let there = [j.toStop.isEmpty ? nil : j.toStop, j.arriveStop].compactMap { $0 }.joined(separator: " ")
            leg = WidgetLeg(
                svc: bus.svc, color: bus.color, paid: bus.paid,
                text: ([L("from %@", bus.stop) + " " + bus.board] + (there.isEmpty ? [] : [there])).joined(separator: " → "))
        } else {
            leg = JourneyText.backup(a, j).map {
                WidgetLeg(svc: j.backup?.svc, color: j.backup?.color, paid: j.backup?.paid ?? false, text: $0)
            }
        }
        return WidgetFace(
            heading: JourneyText.to(a, j),
            headline: headline,
            accent: j.leave.flatMap { headline.contains($0) ? $0 : nil },
            late: a.leaveLate,
            sub: problem ?? JourneyText.arrive(j),
            pill: bus.map { _ in j.live ? WidgetPill(text: L("Live"), good: true) : WidgetPill(text: L("Estimate"), good: false) },
            leg: leg,
            road: Road.of(j, now: now),
            journey: j
        )
    }

    static func isOld(_ a: NextAnswer, now: Date) -> Bool {
        guard a.card != nil else { return true }
        return a.staleAt.map { now >= $0 } ?? false
    }
}

enum WidgetTiming {
    static let minGap: TimeInterval = 15
    static let minLocalGap: TimeInterval = 60
    static let fallback: TimeInterval = 15 * 60
    static let minReload: TimeInterval = 5 * 60

    static func reloadAt(_ next: Date, now: Date) -> Date {
        max(next, now.addingTimeInterval(minReload))
    }

    static func signedOutReload(locked: Bool, now: Date) -> Date? {
        locked ? now.addingTimeInterval(minReload) : nil
    }

    static func serverRefreshAt(_ a: NextAnswer, now: Date) -> Date? {
        let at = [a.planChanges, a.nextChange ?? a.staleAt].compactMap { $0 }.filter { $0 > now }.min()
        return at.map { max($0, now.addingTimeInterval(minGap)) }
    }

    static func nextRefreshAt(_ a: NextAnswer, fetchedAt: Date, now: Date) -> Date {
        serverRefreshAt(a, now: now) ?? max(fetchedAt.addingTimeInterval(fallback), now.addingTimeInterval(minLocalGap))
    }

    static func due(_ a: NextAnswer?, fetchedAt: Date?, now: Date) -> Bool {
        guard let a, let fetchedAt else { return true }
        if WidgetFace.isOld(a, now: now) { return true }
        return nextRefreshAt(a, fetchedAt: fetchedAt, now: fetchedAt) <= now
    }

    static func redraws(_ a: NextAnswer, now: Date, until: Date) -> [Date] {
        var out = [a.nextChange, a.staleAt, a.mode == "rest" ? nil : a.leaveAt, a.departure, a.card?.journey?.boardDate].compactMap { $0 }
        if a.phase == "riding", let ride = a.card?.ride {
            let n = ride.stops.count - 1
            let span = ride.arriveAt.timeIntervalSince(ride.boardAt)
            for k in 1...max(1, n) { out.append(ride.boardAt.addingTimeInterval(span * Double(k) / Double(max(1, n)) + 1)) }
        }
        return out.filter { $0 > now && $0 < until }
    }
}

enum WidgetSwap {
    static let keep: TimeInterval = 60 * 60

    struct Swap: Codable, Equatable {
        var from: String
        var to: String
        var at: Date
    }

    static func twin(_ stops: [NearbyStop]) -> NearbyStop? {
        guard let code = stops.first?.opposite else { return nil }
        return stops.first { $0.stop.code == code }
    }

    static func active(_ stops: [NearbyStop], _ swap: Swap?, now: Date) -> Bool {
        guard let swap else { return false }
        let age = now.timeIntervalSince(swap.at)
        return age >= 0 && age <= keep && stops.first?.stop.code == swap.from && twin(stops)?.stop.code == swap.to
    }

    static func order(_ stops: [NearbyStop], _ swap: Swap?, now: Date) -> [NearbyStop] {
        guard active(stops, swap, now: now), let twin = twin(stops), let first = stops.first else { return stops }
        return [twin, first] + stops.dropFirst().filter { $0.stop.code != twin.stop.code }
    }

    static func offer(_ stops: [NearbyStop], _ swap: Swap?, now: Date, onScreen: Set<String>) -> NearbyStop? {
        if active(stops, swap, now: now) { return stops.first }
        return twin(stops).flatMap { onScreen.contains($0.stop.code) ? nil : $0 }
    }
}
