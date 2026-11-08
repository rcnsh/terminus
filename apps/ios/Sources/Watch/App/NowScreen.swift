import MapKit
import SwiftUI

/// Now on the wrist: the card for what's chosen, in the phone's words and
/// order (NowShows): its head on a band of the hour's sky, the trip's steps
/// under it, then Earlier and Later bus and Directions to the stop. Not
/// going, Go later and Is this wrong? stay on the phone (ADR 0016).
struct NowScreen: View {
    @Environment(WatchModel.self) private var model
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        TimelineView(.periodic(from: .now, by: dimmed ? 60 : 1)) { _ in
            let now = ServerClock.now
            let shows = model.shows
            ScrollViewReader { scroller in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        if case .nearby = shows {
                            NearbyList(now: now)
                        } else {
                            SkyBand(road: road(shows, now)) { inks in
                                CardHead(shows: shows, now: now).environment(\.inks, inks)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .accessibilityIdentifier("now.head")
                            if let e = model.error, model.answer != nil {
                                Text(e).font(.footnote).foregroundStyle(Color.warn).padding(.top, 6)
                            }
                            CardGround(shows: shows, now: now).padding(.top, 4)
                        }
                        LocationNotice().padding(.top, 14)
                        Color.clear.frame(height: 1).id("foot")
                    }
                    .padding(.horizontal, 6)
                }
                #if DEBUG
                    .task {
                        // For screenshots of the card's foot (TERMINUS_SCROLL=foot).
                        guard ProcessInfo.processInfo.environment["TERMINUS_SCROLL"] == "foot" else { return }
                        try? await Task.sleep(for: .seconds(3))
                        scroller.scrollTo("foot", anchor: .bottom)
                    }
                #endif
            }
        }
    }

    /// Your bus on the road only when it stops for you, as on the phone's horizon.
    private func road(_ shows: NowShows, _ now: Date) -> Road {
        let r = shows.road(now: now)
        return r.stop ? r : Road(stop: false, bus: nil, shuttle: r.shuttle)
    }
}

/// The colours words take where they are: in the sky or on the ground.
private struct InksKey: EnvironmentKey { static let defaultValue = Inks.page }

extension EnvironmentValues {
    var inks: Inks {
        get { self[InksKey.self] }
        set { self[InksKey.self] = newValue }
    }
}

// MARK: the head, in the sky

struct CardHead: View {
    let shows: NowShows
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch shows {
            case .nearby:
                EmptyView()
            case .checking:
                HStack(spacing: 8) {
                    ProgressView().frame(width: 20, height: 20)
                    Text(L("Checking…")).foregroundStyle(inks.muted)
                }
                .padding(.vertical, 8)
            case .waiting(let text):
                Text(text).font(.title3.weight(.semibold)).accessibilityIdentifier("now.waiting")
            case .offline(let lines):
                Text("\(L("Offline")) · \(lines.head)").font(.footnote.weight(.semibold)).foregroundStyle(inks.muted)
                Text(lines.big).font(.title3.weight(.bold))
                if let how = lines.how { Text(how).font(.footnote) }
            case .dayDone(let a):
                Text(a.label).font(.title2.weight(.heavy)).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("now.label")
                if let sub = a.doneSub { Text(sub).font(.footnote).foregroundStyle(inks.muted) }
            case .journey(let a, let j):
                Lead(answer: a, now: now)
                Text(JourneyText.to(a, j)).font(.footnote).foregroundStyle(inks.muted).lineLimit(2)
                LeaveHead(answer: a, journey: j, now: now)
                let under = [JourneyText.by(a, j, now: now), j.slack].compactMap { $0 }.joined(separator: " · ")
                if !under.isEmpty { Text(under).font(.footnote).foregroundStyle(a.leaveLate ? inks.late : inks.muted) }
                if j.live || (!a.isClassPlan && a.card?.crowd != nil) {
                    HStack(spacing: 4) {
                        if j.live { SkyPill(text: L("Live"), color: inks.good) }
                        if !a.isClassPlan, let crowd = a.card?.crowd { SkyPill(text: crowd, color: inks.muted) }
                    }
                    .padding(.top, 2)
                }
            case .classPlan(let a):
                Lead(answer: a, now: now)
                Text([a.dest?.label, a.classAt.map(a.startsAt)].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(inks.muted).lineLimit(2)
                Text(a.leaveHeadline(now: now) ?? "").font(.title3.weight(.bold)).foregroundStyle(a.leaveLate ? inks.late : inks.ink)
                    .accessibilityIdentifier("now.leave")
                if let at = a.leaveAt, a.phase != "waiting", at > now {
                    Text(JourneyText.inTime(Int(at.timeIntervalSince(now)))).font(.footnote.weight(.semibold))
                        .foregroundStyle(inks.smallAccent).monospacedDigit()
                }
            case .plain(let a, let old):
                Lead(answer: a, now: now)
                if let head = a.plainHeading { Text(head).font(.footnote).foregroundStyle(inks.muted).lineLimit(2) }
                Text(a.title).font(.title3.weight(.bold)).foregroundStyle(old ? inks.muted : inks.ink)
                if old {
                    Text(L("Updating times…")).font(.footnote).foregroundStyle(inks.muted)
                } else if let at = a.departure {
                    let left = Int(at.timeIntervalSince(now))
                    Text(JourneyText.leaves(left: left)).font(.footnote.weight(.semibold))
                        .foregroundStyle(left > 0 ? inks.smallAccent : inks.muted).monospacedDigit()
                }
            }
        }
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
    }
}

/// What comes before any answer, as on the phone: NUS's live times being
/// down, where the trip is, the ride's progress on the bus, and a warning.
private struct Lead: View {
    let answer: NextAnswer
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        if let notice = answer.card?.notice { Text(notice).font(.footnote).foregroundStyle(inks.warn) }
        if let phase = answer.card?.phaseText { SkyPill(text: phase, color: inks.smallAccent) }
        if answer.phase == "riding", let ride = answer.card?.ride {
            ProgressView(value: ride.progress(at: now)).tint(inks.accent).padding(.vertical, 2)
            Text(ride.nextText(at: now, withChange: false)).font(.footnote)
            if let change = ride.change { Text(change.text).font(.footnote).foregroundStyle(inks.muted) }
        }
        if let warning = answer.card?.warning { Text(warning).font(.footnote.weight(.semibold)).foregroundStyle(inks.warn) }
    }
}

/// "Leave in 6 min" with only the time in the accent; "Leave now" all
/// accent; too late to be on time, all red. As the phone's.
private struct LeaveHead: View {
    let answer: NextAnswer
    let journey: Journey
    let now: Date
    @Environment(\.inks) private var inks

    var body: some View {
        let text = JourneyText.leaveIn(answer, journey, now: now)
        let time = JourneyText.leaveTime(answer, journey, now: now)
        var s = AttributedString(text)
        s.foregroundColor = answer.leaveLate ? inks.late : inks.ink
        if !answer.leaveLate {
            if let time, let r = s.range(of: time) {
                s[r].foregroundColor = inks.accent
            } else if time == nil {
                s.foregroundColor = inks.accent
            }
        }
        return Text(s)
            .font(.system(.title3, weight: .heavy))
            .monospacedDigit()
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("now.leave")
    }
}

/// A small coloured pill, on the sky's chip so it reads over any hour.
struct SkyPill: View {
    let text: String
    let color: Color
    @Environment(\.inks) private var inks

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(inks.chip ?? color.opacity(0.16), in: Capsule())
    }
}

// MARK: the ground

struct CardGround: View {
    let shows: NowShows
    let now: Date
    @Environment(WatchModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch shows {
            case .nearby, .checking, .waiting, .offline:
                EmptyView()
            case .dayDone(let a):
                if let u = a.card?.upcoming { UpcomingCard(upcoming: u) }
                // Your favourites to plan a trip to instead, or where to look, as under the phone's.
                if a.places.isEmpty {
                    Text(
                        a.mode == "rest"
                            ? L("No buses are shown until your day starts. Tap Nearby to check anyway.")
                            : L("Tap Nearby for buses around you.")
                    )
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                } else {
                    Text(L("Going somewhere anyway?")).font(.footnote.weight(.semibold)).foregroundStyle(Color.muted).padding(.top, 6)
                    ForEach(a.places, id: \.key) { p in
                        Button(p.label) { model.choose(.place(key: p.key, label: p.label)) }
                    }
                }
            case .journey(let a, let j):
                Steps(answer: a, journey: j, now: now).padding(.top, 4)
                if let backup = JourneyText.backup(a, j) {
                    Label(backup, systemImage: "bus").font(.footnote).foregroundStyle(Color.muted)
                }
                Small(answer: a, quality: j.bus != nil && !j.live)
                StepButtons(answer: a)
                Directions(answer: a)
            case .classPlan(let a):
                if let how = a.card?.catch {
                    Text(how).font(.body.weight(.semibold)).foregroundStyle(a.leaveLate ? Color.bad : Color.ink)
                }
                if let arrive = a.card?.arrive { Text(arrive).font(.footnote).foregroundStyle(a.leaveLate ? Color.bad : Color.muted) }
                Small(answer: a, quality: false)
                if let goNow = a.card?.goNow {
                    Divider()
                    Text(goNow).font(.footnote).foregroundStyle(Color.muted)
                }
                if let q = a.qualityText { Text(q).font(.caption2).foregroundStyle(Color.muted) }
                StepButtons(answer: a)
                Directions(answer: a)
            case .plain(let a, let old):
                if !old {
                    if !a.detail.isEmpty { Text(a.detail).font(.footnote) }
                    if let leave = a.leaveText(now: now) { Text(leave).font(.body.weight(.semibold)) }
                    let pills = [
                        (a.card?.ride == nil ? a.timing?.text : nil).map { ($0, timingColor(a.timing?.status)) },
                        a.crowdText.map { ($0, Color.muted) },
                    ].compactMap { $0 }
                    if !pills.isEmpty {
                        HStack(spacing: 4) { ForEach(pills, id: \.0) { SkyPill(text: $0.0, color: $0.1) } }
                    }
                    if let q = a.qualityText { Text(q).font(.caption2).foregroundStyle(Color.muted) }
                    StepButtons(answer: a)
                }
                Directions(answer: a)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func timingColor(_ status: String?) -> Color {
        switch status {
        case "late": .bad
        case "tight": .warn
        default: .good
        }
    }
}

/// A busy bus and an estimate are small print, and how sure a bus's time is.
private struct Small: View {
    let answer: NextAnswer
    let quality: Bool

    var body: some View {
        let small = [answer.leaveNote, answer.card?.estimate].compactMap { $0 }
        if !small.isEmpty { Text(small.joined(separator: " ")).font(.caption2).foregroundStyle(Color.muted) }
        if quality, let q = answer.qualityText { Text(q).font(.caption2).foregroundStyle(Color.muted) }
    }
}

/// The next class on a card of its own: when in the accent, what, then where.
private struct UpcomingCard: View {
    let upcoming: Upcoming

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(upcoming.when).font(.caption2.weight(.semibold)).textCase(.uppercase).foregroundStyle(Color.brand)
            Text(upcoming.title).font(.headline)
            if !upcoming.where.isEmpty { Text(upcoming.where).font(.footnote).foregroundStyle(Color.muted) }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// The trip as steps down the card, as the phone's default style: leave
/// and the walk, the stop and its bus, a change, the walk at the far end,
/// and where you get there; each with its time.
private struct Steps: View {
    let answer: NextAnswer
    let journey: Journey
    let now: Date

    var body: some View {
        let a = answer
        let j = journey
        VStack(alignment: .leading, spacing: 0) {
            if j.walk != nil {
                Point(time: j.leave ?? L("now"), dot: .start, line: .walk, below: JourneyText.walk(j)) {
                    Text(L("Leave")).font(.headline)
                }
            }
            if let bus = j.bus {
                Point(
                    time: bus.board, dot: j.walk == nil ? .start : .stop, line: .ride(serviceColor(bus.color)),
                    below: j.change?.firstRideText ?? JourneyText.ride(j)
                ) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(bus.stop).font(.headline).lineLimit(2)
                        HStack(spacing: 4) {
                            BusBadge(svc: bus.svc, color: bus.color, size: 12, paid: bus.paid)
                            if let busIn = JourneyText.busIn(j, now: now) {
                                Text(busIn).font(.caption2).foregroundStyle(Color.muted).lineLimit(1).monospacedDigit()
                            }
                        }
                    }
                }
            }
            if let c = j.change {
                Point(
                    time: c.bus.board, dot: .stop, line: .ride(serviceColor(c.bus.color)),
                    below: [c.changeText, c.rideText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                ) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(c.stop).font(.headline).lineLimit(2)
                        BusBadge(svc: c.bus.svc, color: c.bus.color, size: 12, paid: c.bus.paid)
                    }
                }
            }
            if j.walkEnd != nil {
                Point(time: j.arriveStop ?? "", dot: .stop, line: .walk, below: JourneyText.walkEnd(j)) {
                    Text(j.toStop).font(.headline)
                }
            }
            Point(time: j.arrive ?? "", dot: .end, line: nil, below: j.slack, late: a.leaveLate) {
                Text(j.bus == nil || j.walkEnd != nil ? j.place : j.toStop).font(.headline)
            }
        }
        // Read as one sentence with the head.
        .accessibilityElement(children: .combine)
    }

    enum Dot { case start, stop, end }
    enum Kind {
        case walk
        case ride(Color)
    }

    /// A point on the line: its time over what's there, its dot, and beside
    /// the line how long the stretch to the next point takes.
    struct Point<Title: View>: View {
        let time: String
        let dot: Dot
        let line: Kind?
        let below: String?
        var late = false
        @ViewBuilder var title: Title

        var body: some View {
            HStack(alignment: .top, spacing: 6) {
                VStack(spacing: 0) {
                    Canvas { g, size in
                        let c = CGPoint(x: size.width / 2, y: size.height / 2)
                        func circle(_ r: CGFloat) -> Path { Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r)) }
                        switch dot {
                        case .start: g.fill(circle(5), with: .color(.brand))
                        case .stop: g.stroke(circle(4), with: .color(.ink), lineWidth: 2.5)
                        case .end: g.stroke(circle(5), with: .color(.brand), lineWidth: 4)
                        }
                    }
                    .frame(width: 14, height: 14)
                    .padding(.top, 2)
                    if let line {
                        Canvas { g, size in
                            var p = Path()
                            p.move(to: CGPoint(x: size.width / 2, y: 0))
                            p.addLine(to: CGPoint(x: size.width / 2, y: size.height))
                            switch line {
                            case .walk:
                                g.stroke(p, with: .color(.muted), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [1.5, 5]))
                            case .ride(let c): g.stroke(p, with: .color(c), style: StrokeStyle(lineWidth: 5, lineCap: .round))
                            }
                        }
                        .frame(width: 14)
                        .frame(maxHeight: .infinity)
                        .padding(.vertical, 2)
                    }
                }
                .frame(maxHeight: .infinity, alignment: .top)
                VStack(alignment: .leading, spacing: 1) {
                    Text(time).font(.caption.weight(.semibold)).foregroundStyle(Color.muted).monospacedDigit()
                    title
                    if let below {
                        Text(below).font(.caption2).foregroundStyle(late ? Color.bad : Color.muted).padding(.top, 2)
                    }
                }
                .padding(.bottom, line == nil ? 0 : 8)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// "‹ Earlier bus" and "Later bus ›", and "Best bus" once you've moved, as
/// on the phone; a way with no bus is greyed out, not hidden. Side by side
/// when they fit, else one over the other.
private struct StepButtons: View {
    let answer: NextAnswer
    @Environment(WatchModel.self) private var model

    var body: some View {
        if let s = answer.card?.step {
            VStack(spacing: 6) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        earlier(s)
                        later(s)
                    }
                    VStack(spacing: 6) {
                        earlier(s)
                        later(s)
                    }
                }
                if s.moved {
                    Button(s.bestLabel) { model.step(s, to: nil, dir: nil) }.accessibilityIdentifier("step.best")
                }
            }
            .disabled(model.signalling)
            .padding(.top, 8)
        }
    }

    private func earlier(_ s: Step) -> some View {
        Button {
            model.step(s, to: s.earlier, dir: "earlier")
        } label: {
            Text("‹ \(s.earlierLabel)").lineLimit(1).fixedSize()
        }
        .disabled(s.earlier == nil)
        .accessibilityLabel(s.earlierLabel)
        .accessibilityIdentifier("step.earlier")
    }

    private func later(_ s: Step) -> some View {
        Button {
            model.step(s, to: s.later, dir: "later")
        } label: {
            Text("\(s.laterLabel) ›").lineLimit(1).fixedSize()
        }
        .disabled(s.later == nil)
        .accessibilityLabel(s.laterLabel)
        .accessibilityIdentifier("step.later")
    }
}

/// Walking directions to the stop, in the watch's Maps.
private struct Directions: View {
    let answer: NextAnswer

    var body: some View {
        if let w = answer.card?.walkTo {
            Button {
                let item = MKMapItem(placemark: MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: w.lat, longitude: w.lon)))
                item.name = w.name
                item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeWalking])
            } label: {
                Text(L("Directions to %@", w.name)).lineLimit(2).multilineTextAlignment(.center)
            }
            .tint(.brand)
            .padding(.top, 4)
            .accessibilityIdentifier("directions")
        }
    }
}

/// Without the watch's location: what it's for, and Continue, which asks
/// (worded as on the phone; the system's question is the one that asks).
private struct LocationNotice: View {
    private var locator: Locator { Locator.shared }

    var body: some View {
        if !locator.allowed {
            VStack(alignment: .leading, spacing: 6) {
                Text(
                    L(
                        "Directions can start from your nearest stop, using your location. Without it, terminus assumes you're at your last class or at home."
                    )
                )
                .font(.footnote)
                .foregroundStyle(Color.muted)
                if locator.undecided {
                    Button(L("Continue")) { locator.ask() }.accessibilityIdentifier("location.continue")
                }
            }
        }
    }
}
