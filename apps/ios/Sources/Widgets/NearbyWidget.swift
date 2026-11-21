import SwiftUI
import WidgetKit

struct NearbyWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "nearby", provider: NearbyProvider()) { entry in
            NearbyWidgetView(entry: entry)
        }
        .configurationDisplayName(L("Buses near you"))
        .description(L("The next buses at your stop and across the road"))
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular])
        .contentMarginsDisabled()
    }
}

struct NearbyEntry: TimelineEntry {
    var date: Date
    var paired: Bool
    var stops: [NearbyStop]?
    var fetchedAt: Date?
    var error: String?
    var slot: String
    var swap: WidgetSwap.Swap?
    var newcomer: Bool
    var sample = false
    var standIn = false

    var model: NearbyModel {
        NearbyModel(
            paired: paired, all: stops, swap: swap, fetchedAt: fetchedAt, error: error, now: date, skew: ServerClock.skew, slot: slot,
            refresh: paired && !sample, standIn: standIn)
    }
}

struct NearbyProvider: TimelineProvider {
    func placeholder(in context: Context) -> NearbyEntry { Self.sampleEntry(family: context.family) }

    func getSnapshot(in context: Context, completion: @escaping @Sendable (NearbyEntry) -> Void) {
        let e = Self.entry(family: context.family, at: Date())
        completion(e.stops == nil && context.isPreview ? Self.sampleEntry(family: context.family) : e)
    }

    func getTimeline(in context: Context, completion: @escaping @Sendable (Timeline<NearbyEntry>) -> Void) {
        let family = context.family
        Task {
            await NearbyShared.refreshIfDue()
            completion(Self.timeline(family: family))
        }
    }

    static func slotID(_ family: WidgetFamily) -> String {
        switch family {
        case .systemSmall: "nearby.small"
        case .systemMedium: "nearby.medium"
        case .systemLarge: "nearby.large"
        default: "nearby.rect"
        }
    }

    static func entry(family: WidgetFamily, at date: Date) -> NearbyEntry {
        let paired = TokenStore.read() != nil
        let slot = slotID(family)
        return NearbyEntry(
            date: date, paired: paired, stops: paired ? NearbyShared.stops() : nil, fetchedAt: paired ? NearbyShared.fetchedAt : nil,
            error: paired ? NearbyShared.error : nil, slot: slot, swap: WidgetStore.slot(slot).swap, newcomer: NewToNus.on)
    }

    static func timeline(family: WidgetFamily) -> Timeline<NearbyEntry> {
        let now = Date()
        let first = entry(family: family, at: now)
        guard first.paired else { return Timeline(entries: [first], policy: BusProvider.unpairedPolicy(now: now)) }
        let horizon = now.addingTimeInterval(3 * 3600)
        var moments = BusProvider.skyChanges(after: now, until: horizon)
        var running = false
        if let f = first.fetchedAt, let stops = first.model.stops {
            let old = f.addingTimeInterval(WidgetMode.nearbyOld)
            moments.append(old.addingTimeInterval(1))
            moments += NearbyBoard.redraws(
                Array(stops.prefix(3)), fetchedAt: f, now: now, until: horizon, minutesUntil: old, skew: ServerClock.skew)
            running = stops.prefix(3).contains { s in s.board.contains { $0.etaS != nil } }
        }
        let times = Array(Set(moments.filter { $0 > now && $0 < horizon }.map { $0.timeIntervalSince1970.rounded() })).sorted().prefix(60)
        let entries =
            [first]
            + times.map { t in
                var e = first
                e.date = Date(timeIntervalSince1970: t)
                return e
            }
        let next = now.addingTimeInterval(running || first.stops == nil ? WidgetTiming.minReload : 30 * 60)
        return Timeline(entries: entries, policy: .after(next))
    }

    static func sampleEntry(family: WidgetFamily) -> NearbyEntry {
        func row(_ svc: String, _ color: String, _ eta: Int, _ towards: [String], later: [Int] = [], crowd: String? = nil) -> [String: Any]
        {
            var r: [String: Any] = [
                "svc": svc, "color": color, "etaS": eta, "quality": "live", "towards": towards,
                "later": later.map { ["etaS": $0, "quality": "live"] },
            ]
            if let crowd { r["crowd"] = crowd }
            return r
        }
        let json: [String: Any] = [
            "stops": [
                [
                    "stop": ["code": "UTOWN", "name": "UTown", "longName": "University Town"], "opposite": "UTOWN-OPP",
                    "oppositeAcross": true,
                    "walkS": 120, "available": true, "viaText": "to Kent Ridge MRT, Science",
                    "board": [
                        row("D2", "#8e44c9", 250, ["University Health Centre", "COM 3"], later: [900], crowd: "low"),
                        row("A2", "#e2a600", 430, ["TCOMS", "Kent Ridge MRT"], later: [1300]),
                        row("C", "#3aa64c", 700, ["Kent Ridge MRT"]),
                    ],
                ],
                [
                    "stop": ["code": "UTOWN-OPP", "name": "UTown", "longName": "University Town"], "walkS": 150, "available": true,
                    "viaText": "to PGP, Clementi", "board": [row("D1", "#ec4fa0", 130, ["Yusof Ishak House", "COM 3"], later: [720])],
                ],
            ]
        ]
        let data = (try? JSONSerialization.data(withJSONObject: json)) ?? Data()
        struct R: Decodable { let stops: [NearbyStop] }
        let stops = (try? JSONDecoder().decode(R.self, from: data))?.stops
        return NearbyEntry(
            date: Date(), paired: true, stops: stops, fetchedAt: Date(), error: nil, slot: slotID(family), swap: nil, newcomer: NewToNus.on,
            sample: true)
    }
}

struct NearbyModel {
    let paired: Bool
    let all: [NearbyStop]?
    let swap: WidgetSwap.Swap?
    let fetchedAt: Date?
    let error: String?
    let now: Date
    let skew: TimeInterval
    let slot: String?
    let refresh: Bool
    var standIn = false

    var stops: [NearbyStop]? { all.map { WidgetSwap.order($0, swap, now: now) } }
    var first: NearbyStop? { stops?.first }

    func busesAt(_ stop: NearbyStop) -> [StopBus] {
        NearbyBoard.buses(stop, fetchedAt: fetchedAt ?? .distantPast, now: now, skew: skew)
    }

    var buses: [StopBus] { first.map(busesAt) ?? [] }

    var old: Bool {
        (fetchedAt.map { now.timeIntervalSince($0) > WidgetMode.nearbyOld } ?? true) && buses.contains { !$0.first }
    }

    func minutes(_ b: StopBus) -> Int? { old || b.first ? nil : NearbyBoard.minutesLeft(b.at, now: now) }

    func clock(_ d: Date) -> String { shortCampusTime(d.addingTimeInterval(skew)) }

    func timeText(_ b: StopBus) -> String { (b.live || b.first ? "" : "~") + clock(b.at) }

    func firstLabel(_ b: StopBus) -> String { NearbyBoard.firstLabel(b.at.addingTimeInterval(skew), now: now.addingTimeInterval(skew)) }

    func nextLine(_ b: StopBus, _ shown: [StopBus]) -> String {
        guard let next = b.next else { return b.endsHere ? L("Ends here") : "" }
        if let end = NearbyBoard.endIfNeeded(b, shown: shown) { return L("Next %@, to %@", next, end) }
        return L("Next %@", next)
    }

    func laterLine(_ b: StopBus) -> String {
        b.later.isEmpty ? "" : L("then %@", b.later.prefix(2).map(clock).joined(separator: L(", ")))
    }

    var title: String {
        guard paired else { return "terminus" }
        return first.map { $0.stop.longName ?? $0.stop.name } ?? L("Nearby")
    }

    var shortTitle: String { paired ? first?.stop.name ?? title : title }

    static func walk(_ stop: NearbyStop) -> String {
        let s = stop.walkS ?? 0
        return s < 60 ? L("here") : L("%@ min walk", "\((s + 30) / 60)")
    }

    func problem(_ buses: [StopBus]) -> String? {
        if !paired { return error ?? L("Open terminus to sign in") }
        if error == WidgetFace.updating && (first == nil || buses.isEmpty) { return L("Checking…") }
        guard let stops else { return error ?? L("Tap ↻ to see the buses near you") }
        guard let first = stops.first else { return error ?? L("No stops near you") }
        if buses.isEmpty { return first.available ? L("No buses due") : L("No live data") }
        return nil
    }

    var spoken: String {
        if standIn { return L("Checking…") }
        let buses = buses
        guard let first, problem(buses) == nil else { return Spoken.sentences(L("Buses near you"), problem(buses)) }
        let due = buses.prefix(3).map { b in
            [b.svc, timeText(b), b.first ? firstLabel(b) : minutes(b).map { NearbyBoard.minutesText($0, live: b.live) }].compactMap { $0 }
                .joined(separator: " ")
        }
        return Spoken.sentences(L("Buses near you"), first.stop.longName ?? first.stop.name, due.joined(separator: " · "))
    }
}
