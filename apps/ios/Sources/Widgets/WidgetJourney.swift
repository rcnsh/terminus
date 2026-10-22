import SwiftUI

/// A trip's steps on the ground of the large widget, under the headline the
/// sky already shows, in the card style chosen in Settings › Appearance:
/// Steps down the side with the ride in its service's colour, or the Route
/// across. As Android's WidgetJourney.
struct JourneyView: View {
    let answer: NextAnswer
    let journey: Journey
    let style: String
    let inks: Inks
    let page: Color
    let now: Date

    /// A step's height: its name and the line under it.
    static let step: CGFloat = 36

    /// The room each style takes.
    static func height(_ j: Journey, style: String) -> CGFloat {
        switch style {
        case "route": 52
        default: step * CGFloat((j.bus != nil ? 3 : 2) + (j.change != nil ? 1 : 0)) - (lastUnder(j) == nil ? 12 : 0)
        }
    }

    /// Under the last step: "2 min walk from UTown", or a class's "9 min early".
    static func lastUnder(_ j: Journey) -> String? { j.walkEnd != nil ? JourneyText.arriveWhere(j) : j.slack }

    var body: some View {
        switch style {
        case "route": route
        default: steps
        }
    }

    // MARK: Steps

    private enum Dot { case you, stop, there }

    private var steps: some View {
        let j = journey
        let there = j.bus != nil ? (j.toStop.isEmpty ? j.place : j.toStop) : j.place
        return VStack(alignment: .leading, spacing: 0) {
            if j.walk != nil {
                stepRow(time: j.leave ?? L("Now"), dot: .you, rail: .walk, name: L("Leave"), under: JourneyText.walk(j), bus: nil)
            }
            if let bus = j.bus {
                stepRow(
                    time: bus.board, dot: .stop, rail: .ride(bus.color), name: bus.stop,
                    under: j.change?.firstRideText ?? JourneyText.ride(j), bus: bus)
            }
            if let c = j.change {
                stepRow(
                    time: c.bus.board, dot: .stop, rail: .ride(c.bus.color), name: c.stop, under: c.changeText, bus: c.bus, countdown: false
                )
            }
            stepRow(time: j.arriveStop ?? j.arrive ?? "", dot: .there, rail: nil, name: there, under: Self.lastUnder(j), bus: nil)
        }
    }

    private enum Rail {
        case walk
        case ride(String?)
    }

    private func stepRow(time: String, dot: Dot, rail: Rail?, name: String, under: String?, bus: Journey.Bus?, countdown: Bool = true)
        -> some View
    {
        HStack(alignment: .top, spacing: 6) {
            Text(verbatim: time).font(.system(size: 13, weight: .medium)).foregroundStyle(inks.ink).lineLimit(1).frame(
                width: 64, alignment: .leading)
            VStack(spacing: 2) {
                switch dot {
                case .you: Circle().fill(inks.accent).frame(width: 11, height: 11)
                case .stop, .there:
                    Circle().strokeBorder(dot == .there ? inks.accent : inks.ink, lineWidth: 3).background(Circle().fill(page)).frame(
                        width: 11, height: 11)
                }
                switch rail {
                case .walk:
                    VStack(spacing: 2.5) { ForEach(0..<4, id: \.self) { _ in Circle().fill(inks.muted).frame(width: 2.5, height: 2.5) } }
                case .ride(let color):
                    Capsule().fill(serviceColor(color)).frame(width: 3, height: Self.step - 15)
                case nil: EmptyView()
                }
            }
            .frame(width: 14)
            .padding(.top, 3)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verbatim: name).font(.system(size: 13, weight: .bold)).foregroundStyle(inks.ink).lineLimit(1)
                    if let bus {
                        BusBadge(svc: bus.svc, color: bus.color, size: 11, paid: bus.paid)
                        if countdown, let inAt = JourneyText.busIn(journey, now: now) { small(inAt, inks.muted, 11) }
                    }
                }
                if let under { small(under, inks.muted, 11.5) }
            }
            Spacer(minLength: 0)
        }
        .frame(height: dot == .there && under == nil ? Self.step - 12 : Self.step, alignment: .top)
    }

    // MARK: Route

    private var route: some View {
        let j = journey
        // A change of bus takes the room of the walk to the stop.
        let change = j.bus == nil ? nil : j.change
        return HStack(alignment: .top, spacing: 0) {
            if change == nil, let walk = j.walk {
                point(L("You"), j.leave ?? L("Now"), inks.accent)
                stretch(walk, bus: nil, color: inks.muted, thick: 2)
            }
            if let bus = j.bus {
                point(bus.stop, bus.board, inks.ink)
                stretch(change?.firstRide ?? j.ride ?? "", bus: bus, color: serviceColor(bus.color), thick: 4)
                // The stop the second bus goes from, then its ride, as on the app's line.
                if let c = change {
                    point(c.stop, c.bus.board, inks.ink)
                    stretch(c.ride ?? "", bus: c.bus, color: serviceColor(c.bus.color), thick: 4)
                }
                point(j.walkEnd != nil ? j.place : j.toStop, j.arrive ?? "", inks.ink)
            } else {
                point(j.place, j.arrive ?? "", inks.ink)
            }
        }
    }

    private func point(_ name: String, _ time: String, _ dot: Color) -> some View {
        VStack(spacing: 1) {
            Spacer().frame(height: 16)
            Circle().fill(dot).frame(width: 10, height: 10)
            Text(verbatim: name).font(.system(size: 11, weight: .medium)).foregroundStyle(inks.ink).lineLimit(1).minimumScaleFactor(0.8)
            Text(verbatim: time).font(.system(size: 11)).foregroundStyle(inks.muted).lineLimit(1)
        }
        .frame(width: 60)
    }

    private func stretch(_ caption: String, bus: Journey.Bus?, color: Color, thick: CGFloat) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                if let bus { BusBadge(svc: bus.svc, color: bus.color, size: 11, paid: bus.paid) }
                small(caption, inks.muted, 11)
            }
            .frame(height: 16)
            Capsule().fill(color).frame(height: thick).frame(height: 10)
        }
        .frame(maxWidth: .infinity)
    }

}
