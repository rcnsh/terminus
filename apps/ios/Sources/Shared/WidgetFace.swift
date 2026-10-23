import Foundation

/// What a widget shows: the timetable's plan by default; its buttons switch
/// it, in place, to the buses near you or the quickest way from where you
/// are to one of your places. As Android's WidgetModes.
enum WidgetMode: Hashable, Sendable {
    case timetable
    case nearby
    /// A saved place (`place:<key>`) or a stop looked up (`stop:<code>`).
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

    /// What it asks /me/next for.
    var target: Target? {
        guard case .to(let id, let label) = self else { return nil }
        if id.hasPrefix("place:") { return .place(key: String(id.dropFirst(6))) }
        return .code(String(id.dropFirst(5)), label: label)
    }

    /// Where a tap on the widget opens the app: the view it shows.
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

    /// A place chosen on the widget goes back to the timetable after this long.
    static let keep: TimeInterval = 30 * 60
    /// Nearby's countdowns are guesses past this: dimmed then.
    static let nearbyOld: TimeInterval = 180
    /// A chosen place's answer is asked for again in the background at most this often.
    static let refetch: TimeInterval = 60

    /// The mode to show now: the chosen one, unless it has run out or a trip
    /// has become due since it was chosen (the timetable matters then).
    static func effective(_ chosen: WidgetMode, at chosenAt: Date?, plan: NextAnswer?, rowShown: Bool, now: Date) -> WidgetMode {
        guard chosen != .timetable, rowShown, let chosenAt else { return .timetable }
        if now.timeIntervalSince(chosenAt) > keep { return .timetable }
        // When the trip turned due: the server's reminder time, else its leave time.
        let dueAt = plan?.card?.remindAt.flatMap(parseISODate) ?? plan?.leaveAt
        if let dueAt, dueAt > chosenAt, dueAt <= now, TripPrefs.tripPhases.contains(plan?.phase ?? "") { return .timetable }
        return chosen
    }

    /// The buttons for a row `width` points wide: Timetable and Nearby, then
    /// the places, then the ones added from "Go somewhere else", as many as
    /// fit; but the place added last always gets the last button. None if
    /// Timetable and Nearby don't fit.
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

    /// How many buttons fit a row this wide: the label at its 13-point font's
    /// width (about 7.2 a Latin letter, 13 a Chinese character), 12 points of
    /// padding each side and 6 between. A button cut in half is worse than one fewer.
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

/// A service's badge and a line beside it, under the horizon: the leg to take, the ride's next stop.
struct WidgetLeg: Equatable {
    var svc: String?
    var color: String?
    var paid = false
    var text: String
}

/// "Live" in green, or "Estimate" plain: how sure the time is, as on Now.
struct WidgetPill: Equatable {
    var text: String
    var good: Bool
}

/// Done for the day: the next class, in a pane of its own ("Tomorrow · Sat", "GEA1000 at 10:00", "At UTown").
struct WidgetTile: Equatable {
    var label: String
    var title: String
    var place: String?
}

/// What a widget says, whatever its size: a line above, the headline (with
/// `accent`, the time to leave, in the accent colour), a line under it with
/// a pill, and what's on the ground and on the horizon's road.
/// Each size shows as much as fits. Worked out once from the answer, so every
/// size says the same thing. As Android's Face.
struct WidgetFace {
    var heading: String?
    var headline: String
    var accent: String?
    /// The trip misses the class: the headline in the late colour.
    var late = false
    /// The times may be old: the headline dimmed.
    var dim = false
    var sub: String?
    var pill: WidgetPill?
    var leg: WidgetLeg?
    /// The horizon: your stop's sign, your bus and how far off it is; else a shuttle going by.
    var road = Road()
    var tile: WidgetTile?
    var journey: Journey?

    /// The accent part, when the headline has it: what a small widget shows big.
    var big: String? { accent.flatMap { !$0.isEmpty && headline.contains($0) ? $0 : nil } }

    /// The headline without `big` ("Leave by"), shown small with it.
    var bigLabel: String? {
        guard let big else { return nil }
        let rest = headline.replacingOccurrences(of: big, with: "").trimmingCharacters(in: CharacterSet(charactersIn: " ,·~约"))
        return rest.isEmpty ? nil : rest
    }

    /// `big` comes first in the headline (Chinese: "约 09:36 前出发"): its label goes after it, not over.
    var bigFirst: Bool {
        guard let big else { return false }
        let h = headline.trimmingCharacters(in: CharacterSet(charactersIn: " ~约"))
        return h.hasPrefix(big)
    }

    /// Stored as the error while a refresh is under way; shown as "Updating…".
    static let updating = "Updating…"

    /// The face for `answer` (nil before any) on the widget's `mode`, with
    /// the last `error`; `offline` is the day plan's next thing when the
    /// answer can't be trusted. `now` is on the server's clock.
    static func of(paired: Bool, mode: WidgetMode, answer: NextAnswer?, error: String?, offline: OfflineDay.Pick?, now: Date) -> WidgetFace
    {
        if !paired { return WidgetFace(headline: "terminus", sub: error ?? L("Open terminus to sign in")) }
        // A problem, or a refresh under way, says so under the headline, in place of what's there.
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
            // There, outside the day, or a free day: no bus, and the next class when there is one.
            let next = card?.upcoming
            return WidgetFace(
                heading: card?.phaseText,
                headline: answer.label,
                sub: problem ?? (next == nil && !answer.detail.isEmpty ? answer.detail : nil),
                tile: next.map { WidgetTile(label: $0.when, title: $0.title, place: $0.where.isEmpty ? nil : $0.where) }
            )
        }
        if let ride {
            // On the bus: where you get off and when, the bus nearing that stop's sign, and the next stop.
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
            // An older server's class, or one whose times are old: when to leave leads.
            let heading = [card?.phaseText, answer.dest?.label, answer.classAt.map { L("starts %@", campusTime($0)) }].compactMap { $0 }
                .joined(separator: " · ")
            return WidgetFace(
                heading: heading.isEmpty ? nil : heading,
                headline: answer.leaveHeadline(now: now) ?? answer.title,
                late: answer.leaveLate && !old,
                dim: old,
                sub: problem ?? (old ? L("Times may be out of date · tap ↻ to refresh") : card?.catchLine)
            )
        }
        // A clock time stays true until the bus leaves; once it's gone, or the
        // data is old, dim it and ask for a tap rather than lie.
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

    /// A trip by bus or on foot: when to leave leads, the leg along the ground, your bus nearing your stop.
    private static func trip(_ a: NextAnswer, _ j: Journey, problem: String?, now: Date) -> WidgetFace {
        let bus = j.bus
        let headline = a.leaveHeadline(now: now) ?? L("Leave now")
        let leg: WidgetLeg?
        if let bus {
            // "from PGP 9:42 → UTown 9:52": where to board, and where it gets you.
            let there = [j.toStop.isEmpty ? nil : j.toStop, j.arriveStop].compactMap { $0 }.joined(separator: " ")
            leg = WidgetLeg(
                svc: bus.svc, color: bus.color, paid: bus.paid,
                text: ([L("from %@", bus.stop) + " " + bus.board] + (there.isEmpty ? [] : [there])).joined(separator: " → "))
        } else {
            // On foot: the bus it beats, or for a class the one to go now on.
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

    /// Past the card's `staleAt`: the bus in it has left, the plan has moved
    /// on, or it's 15 minutes old. A card without one (setup, rest, free)
    /// never dims by itself; an answer with no card at all counts as old.
    static func isOld(_ a: NextAnswer, now: Date) -> Bool {
        guard a.card != nil else { return true }
        return a.staleAt.map { now >= $0 } ?? false
    }
}

/// When a widget needs a new answer, and when it looks different without one.
/// Times are on the server's clock. As Android's Refresher.
enum WidgetTiming {
    /// Never refresh sooner than this after the last, at a moment the server gave.
    static let minGap: TimeInterval = 15
    /// With no moment from the server, never sooner than this.
    static let minLocalGap: TimeInterval = 60
    /// With no moment from the server at all.
    static let fallback: TimeInterval = 15 * 60
    /// WidgetKit is never asked to reload a timeline sooner than this: each
    /// reload may fetch, and a minute apart on a trip would spend its daily
    /// budget by morning. The entries in between redraw by themselves, and
    /// the app, a push and the background refresh reload when the card changes.
    static let minReload: TimeInterval = 5 * 60

    /// When to ask WidgetKit for the next reload, for a refresh wanted at
    /// `next`: never sooner than `minReload` after `now` (the same clock).
    static func reloadAt(_ next: Date, now: Date) -> Date {
        max(next, now.addingTimeInterval(minReload))
    }

    /// When a widget with no token asks again: in `minReload` while the
    /// keychain is locked (before the first unlock after a restart), as the
    /// token may be there unread; never when signed out, since signing in
    /// reloads it.
    static func signedOutReload(locked: Bool, now: Date) -> Date? {
        locked ? now.addingTimeInterval(minReload) : nil
    }

    /// The next of the server's own moments for a refresh: the plan moving on
    /// (`refreshAt`) or the card changing (`nextChangeAt`, else `staleAt`).
    static func serverRefreshAt(_ a: NextAnswer, now: Date) -> Date? {
        let at = [a.planChanges, a.nextChange ?? a.staleAt].compactMap { $0 }.filter { $0 > now }.min()
        return at.map { max($0, now.addingTimeInterval(minGap)) }
    }

    /// When this answer (fetched at `fetchedAt`) next needs asking for again.
    static func nextRefreshAt(_ a: NextAnswer, fetchedAt: Date, now: Date) -> Date {
        serverRefreshAt(a, now: now) ?? max(fetchedAt.addingTimeInterval(fallback), now.addingTimeInterval(minLocalGap))
    }

    /// Whether the kept answer is due a fetch now: none, past its staleAt, or past the moment it gave when it came.
    static func due(_ a: NextAnswer?, fetchedAt: Date?, now: Date) -> Bool {
        guard let a, let fetchedAt else { return true }
        if WidgetFace.isOld(a, now: now) { return true }
        return nextRefreshAt(a, fetchedAt: fetchedAt, now: fetchedAt) <= now
    }

    /// The moments a widget showing `a` looks different with nothing new:
    /// its card changing or going stale, "Leave by" turning into "Leave
    /// now", the bus leaving, and each stop passed on the ride.
    static func redraws(_ a: NextAnswer, now: Date, until: Date) -> [Date] {
        var out = [a.nextChange, a.staleAt, a.mode == "rest" ? nil : a.leaveAt, a.departure, a.card?.journey?.boardDate].compactMap { $0 }
        if a.phase == "riding", let ride = a.card?.ride {
            let n = ride.stops.count - 1
            let span = ride.arriveAt.timeIntervalSince(ride.boardAt)
            // Each stop is passed when the clock says so (Ride.passed): a second after, to be sure.
            for k in 1...max(1, n) { out.append(ride.boardAt.addingTimeInterval(span * Double(k) / Double(max(1, n)) + 1)) }
        }
        return out.filter { $0 > now && $0 < until }
    }
}

/// The other side of the road on the Nearby widget. Stops across a road from
/// each other are a few metres apart, within GPS error, so the nearest stop
/// can be the wrong side. The swap button puts the twin first; it stays
/// swapped while the nearest stop is the same, for up to an hour. As Android's NearbySwap.
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

    /// The stops as shown: the twin first and the nearest second while swapped.
    static func order(_ stops: [NearbyStop], _ swap: Swap?, now: Date) -> [NearbyStop] {
        guard active(stops, swap, now: now), let twin = twin(stops), let first = stops.first else { return stops }
        return [twin, first] + stops.dropFirst().filter { $0.stop.code != twin.stop.code }
    }

    /// The stop the swap button offers: the twin, or the nearest again while
    /// swapped. None when the twin is already on screen.
    static func offer(_ stops: [NearbyStop], _ swap: Swap?, now: Date, onScreen: Set<String>) -> NearbyStop? {
        if active(stops, swap, now: now) { return stops.first }
        return twin(stops).flatMap { onScreen.contains($0.stop.code) ? nil : $0 }
    }
}
