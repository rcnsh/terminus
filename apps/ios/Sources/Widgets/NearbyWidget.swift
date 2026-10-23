import SwiftUI
import WidgetKit

/// "Buses near you": the nearest stop's buses, and the stop across the road
/// beside them where there's room, at every size the Home Screen has and on
/// the Lock Screen. Draws the board every widget showing buses near you
/// shares (NearbyShared). As Android's NearbyWidget.
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

/// One moment of a Buses near you widget: the shared board as kept, read once.
struct NearbyEntry: TimelineEntry {
    var date: Date
    var paired: Bool
    /// In the API's order, nearest first; nil before any board.
    var stops: [NearbyStop]?
    var fetchedAt: Date?
    var error: String?
    /// The slot this size keeps its swap in (WidgetStore.nearbySlots).
    var slot: String
    var swap: WidgetSwap.Swap?
    var newcomer: Bool
    /// Made-up buses for the widget gallery, before the app has fetched any.
    var sample = false

    var model: NearbyModel {
        NearbyModel(
            paired: paired, all: stops, swap: swap, fetchedAt: fetchedAt, error: error, now: date, skew: ServerClock.skew, slot: slot,
            refresh: paired && !sample)
    }
}

/// The widget's timeline. Each time WidgetKit asks: the shared board fetched
/// again if it's over a minute old, then an entry for now and for each moment
/// the widget looks different by itself (a bus going, a minute off a bus's
/// count while the times are new, the times turning old, the sky's hour). No
/// more polling than that: WidgetKit spaces the asks out, and the app
/// redraws the widget whenever it fetches the board itself.
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
            // The first few as shown: your stop, and the one beside it on the larger sizes.
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
        // Asked again for a new board, but no sooner than WidgetTiming.minReload;
        // with nothing running, a timetable's first buses don't change.
        let next = now.addingTimeInterval(running || first.stops == nil ? WidgetTiming.minReload : 30 * 60)
        return Timeline(entries: entries, policy: .after(next))
    }

    // MARK: the gallery's sample

    /// Buses to show in the widget gallery before there's a board: UTown and
    /// the stop across the road, as the server words them.
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

/// What a Buses near you layout draws from: the board as kept, in the order
/// shown, and how old it is; worked out once. The Nearby chip and the large
/// widget's next buses draw from one too. As Android's NearbyView.
struct NearbyModel {
    let paired: Bool
    /// In the API's order, for the swap button.
    let all: [NearbyStop]?
    let swap: WidgetSwap.Swap?
    /// When the board came, on this phone's clock.
    let fetchedAt: Date?
    /// The last fetch's problem, or WidgetFace.updating.
    let error: String?
    /// This phone's clock.
    let now: Date
    let skew: TimeInterval
    /// Where its ↻ and swap button keep their state; nil for none.
    let slot: String?
    let refresh: Bool

    /// As shown: the stop across the road first after a swap.
    var stops: [NearbyStop]? { all.map { WidgetSwap.order($0, swap, now: now) } }
    var first: NearbyStop? { stops?.first }

    func busesAt(_ stop: NearbyStop) -> [StopBus] {
        NearbyBoard.buses(stop, fetchedAt: fetchedAt ?? .distantPast, now: now, skew: skew)
    }

    var buses: [StopBus] { first.map(busesAt) ?? [] }

    /// Past WidgetMode.nearbyOld: the times are dimmed and the line above says
    /// so. First buses are a timetable's, so they don't go old.
    var old: Bool {
        (fetchedAt.map { now.timeIntervalSince($0) > WidgetMode.nearbyOld } ?? true) && buses.contains { !$0.first }
    }

    /// Whole minutes until `b`, when it shows them: not while the times may
    /// be old (a count would claim more than an old guess knows), and not for
    /// a first bus, which is a timetable's. Nil: the clock time alone.
    func minutes(_ b: StopBus) -> Int? { old || b.first ? nil : NearbyBoard.minutesLeft(b.at, now: now) }

    /// A time on this phone's clock as campus time, short ("9:42").
    func clock(_ d: Date) -> String { shortCampusTime(d.addingTimeInterval(skew)) }

    /// "9:42", "~9:48" for a timetable's guess.
    func timeText(_ b: StopBus) -> String { (b.live || b.first ? "" : "~") + clock(b.at) }

    func firstLabel(_ b: StopBus) -> String { NearbyBoard.firstLabel(b.at.addingTimeInterval(skew), now: now.addingTimeInterval(skew)) }

    /// "Next Yusof Ishak House"; with where it ends when another bus shown stops there next too; "Ends here".
    func nextLine(_ b: StopBus, _ shown: [StopBus]) -> String {
        guard let next = b.next else { return b.endsHere ? L("Ends here") : "" }
        if let end = NearbyBoard.endIfNeeded(b, shown: shown) { return L("Next %@, to %@", next, end) }
        return L("Next %@", next)
    }

    /// "then 9:50, 9:58"; empty with none after it.
    func laterLine(_ b: StopBus) -> String {
        b.later.isEmpty ? "" : L("then %@", b.later.prefix(2).map(clock).joined(separator: L(", ")))
    }

    /// The stop's name, or what to call the widget before there is one.
    var title: String {
        guard paired else { return "terminus" }
        return first.map { $0.stop.longName ?? $0.stop.name } ?? L("Nearby")
    }

    /// The stop's short name ("PGP Foyer"), where the full one wouldn't fit.
    var shortTitle: String { paired ? first?.stop.name ?? title : title }

    /// "2 min walk", or "here" under a minute.
    static func walk(_ stop: NearbyStop) -> String { stop.walkS < 60 ? L("here") : L("%@ min walk", "\((stop.walkS + 30) / 60)") }

    /// The words shown instead of buses; nil when there are buses to show.
    func problem(_ buses: [StopBus]) -> String? {
        if !paired { return error ?? L("Open terminus to sign in") }
        if error == WidgetFace.updating && (first == nil || buses.isEmpty) { return L("Checking…") }
        guard let stops else { return error ?? L("Tap ↻ to see the buses near you") }
        guard let first = stops.first else { return error ?? L("No stops near you") }
        if buses.isEmpty { return first.available ? L("No buses due") : L("No live data") }
        return nil
    }

    /// What VoiceOver says: the stop and its next few buses, as one sentence.
    var spoken: String {
        let buses = buses
        guard let first, problem(buses) == nil else { return Spoken.sentences(L("Buses near you"), problem(buses)) }
        let due = buses.prefix(3).map { b in
            [b.svc, timeText(b), b.first ? firstLabel(b) : minutes(b).map { NearbyBoard.minutesText($0, live: b.live) }].compactMap { $0 }
                .joined(separator: " ")
        }
        return Spoken.sentences(L("Buses near you"), first.stop.longName ?? first.stop.name, due.joined(separator: " · "))
    }
}
