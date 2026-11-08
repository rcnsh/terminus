import SwiftUI
import WidgetKit

/// What a complication says at one moment, worked out once from the plan
/// kept in the app group, so every family says the same thing: the
/// headline ("Leave in 9 min"), the bus, where it's from and how sure its
/// time is. Every word is the card's or one the iPhone's widgets and Now
/// already use (WidgetFace, JourneyText); only the countdown is worked out
/// here, because it ticks.
struct Glance: Equatable {
    /// The bus to catch, as it's painted.
    var svc: String?
    var color: String?
    var paid = false
    /// Over the headline: where it's for ("GEA1000").
    var heading: String?
    /// "Leave in 9 min", "Leave now", "D2 at 09:41", "Off at UTown 09:52".
    var headline: String
    /// The last two minutes before leaving, drawn as a timer that ticks by
    /// itself ("Leave in 1:42"): the time it counts down to.
    var countdownTo: Date?
    /// The circular face's figure: "9 min", or a clock time with no countdown.
    var big: String?
    /// Under the headline: the bus's stop and time ("from PGP 09:42"), else the line under the card's headline.
    var under: String?
    /// "Live", or "~" for a timetable guess.
    var sure: String?
    /// The trip misses the class: the headline in the late colour.
    var late = false
    /// Times that may be old: dimmed.
    var dim = false

    /// The card's 12 characters for a glance ("Leave 09:38"), when it has them.
    var short: String?
    /// Whether the headline counts down to leaving.
    var isCountdown = false

    /// The inline face's one line: "Leave in 9 min · D2"; otherwise the
    /// card's `glance`, as the iPhone's Lock Screen has it.
    var inline: String {
        if isCountdown { return svc.map { "\(headline) · \($0)" } ?? headline }
        return short ?? headline
    }

    /// The glance for `answer` (nil before any) at `now`, on the server's clock.
    static func of(paired: Bool, answer: NextAnswer?, error: String?, now: Date) -> Glance {
        guard paired else { return Glance(headline: "terminus", under: L("Open terminus on your iPhone")) }
        let face = WidgetFace.of(paired: true, mode: .timetable, answer: answer, error: error, offline: nil, now: now)
        guard let a = answer else { return Glance(headline: face.headline, under: face.sub) }
        let old = WidgetFace.isOld(a, now: now)
        let done = a.arrived || a.mode == "rest" || a.isFree
        if !old, !done, a.card?.phase != "riding", let j = a.card?.journey {
            var g = Glance(heading: j.place, headline: JourneyText.leaveIn(a, j, now: now), late: a.leaveLate, short: a.card?.glance)
            g.isCountdown = a.phase != "waiting"
            if let left = JourneyText.secondsToLeave(a, j, now: now) {
                if left < 120 {
                    g.countdownTo = a.leaveAt
                } else {
                    g.big = L("%@ min", "\((left + 30) / 60)")
                }
            } else {
                g.big = j.bus?.board ?? j.leave
            }
            if let bus = j.bus {
                g.svc = bus.svc
                g.color = bus.color
                g.paid = bus.paid
                g.under = L("from %@", bus.stop) + " " + bus.board
                g.sure = j.live ? L("Live") : "~"
            } else {
                g.under = JourneyText.arrive(j)
            }
            return g
        }
        return Glance(
            svc: face.leg?.svc, color: face.leg?.color, paid: face.leg?.paid ?? false,
            heading: face.heading, headline: face.headline, big: face.big, under: face.leg?.text ?? face.sub, late: face.late,
            dim: face.dim, short: old ? nil : a.card?.glance)
    }

    /// The moments the glance looks different with nothing new: each minute
    /// the countdown's figure changes, the last two minutes' timer starting,
    /// and leaving; with the iPhone widget's own (WidgetTiming.redraws).
    static func redraws(_ a: NextAnswer, now: Date, until: Date) -> [Date] {
        var out = WidgetTiming.redraws(a, now: now, until: until)
        if let j = a.card?.journey, a.phase != "waiting", j.leave != nil, let leave = a.leaveAt {
            // The figure is rounded (JourneyText.leaveIn): it drops a minute half a minute before each whole one.
            for k in 2...60 { out.append(leave.addingTimeInterval(-(Double(k) * 60 + 29.5))) }
            out.append(leave.addingTimeInterval(-119.5))
            out.append(leave)
        }
        return Array(Set(out.filter { $0 > now && $0 < until })).sorted()
    }

    /// How much the Smart Stack should want it: most on a trip and the hour
    /// before leaving, a little otherwise, nothing signed out.
    static func relevance(paired: Bool, answer: NextAnswer?, now: Date) -> Double {
        guard paired, let a = answer, !WidgetFace.isOld(a, now: now) else { return 0 }
        if TripPrefs.tripPhases.contains(a.phase) { return 1 }
        if let leave = a.leaveAt, leave > now, leave.timeIntervalSince(now) < 3600 { return 0.8 }
        return 0.1
    }
}

/// The colours a complication draws in: full colour on a face that shows
/// them, the face's tint otherwise (`widgetAccentable`).
private let ink = Color(rgb: 0xF2EFEB)

/// One line beside the clock: "Leave in 9 min · D2".
struct InlineGlance: View {
    let g: Glance

    var body: some View {
        if let to = g.countdownTo {
            // The timer can't go inside a phrase that's looked up: the phrase is split around its blank.
            let parts = L("Leave in %@", "\u{1}").components(separatedBy: "\u{1}")
            Text(verbatim: parts.first ?? "") + Text(timerInterval: Date.now...max(Date.now, to), countsDown: true)
                + Text(verbatim: (parts.count > 1 ? parts[1] : "") + (g.svc.map { " · \($0)" } ?? ""))
        } else {
            Label {
                Text(verbatim: g.inline)
            } icon: {
                Image(systemName: "bus.fill")
            }
        }
    }
}

/// The bus over the minutes to leave (or the time that matters), in a circle.
struct CircularGlance: View {
    let g: Glance

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let svc = g.svc {
                    Text(verbatim: svc).font(.system(size: 12, weight: .heavy)).lineLimit(1).minimumScaleFactor(0.6)
                        .foregroundStyle(Color(hex: g.color) ?? ink).widgetAccentable()
                } else {
                    Image(systemName: "bus.fill").font(.system(size: 12)).widgetAccentable()
                }
                Group {
                    if let to = g.countdownTo {
                        Text(timerInterval: Date.now...max(Date.now, to), countsDown: true).multilineTextAlignment(.center)
                    } else {
                        Text(verbatim: g.big ?? "–")
                    }
                }
                .font(.system(size: 15, weight: .bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            }
            .padding(4)
        }
    }
}

/// Three lines: the bus and where it's for, the headline, and the stop with Live or "~".
struct RectangularGlance: View {
    let g: Glance

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 4) {
                if let svc = g.svc {
                    Text(verbatim: g.paid ? "\(svc) $" : svc).font(.system(size: 13, weight: .heavy)).foregroundStyle(
                        inkOn(hexRGB(g.color ?? ""))
                    )
                    .padding(.horizontal, 4)
                    .background(serviceColor(g.color), in: RoundedRectangle(cornerRadius: 4))
                    .widgetAccentable()
                }
                Text(verbatim: g.heading ?? "terminus").font(.system(size: 14, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
            }
            Group {
                if let to = g.countdownTo {
                    let parts = L("Leave in %@", "\u{1}").components(separatedBy: "\u{1}")
                    Text(verbatim: parts.first ?? "") + Text(timerInterval: Date.now...max(Date.now, to), countsDown: true)
                        + Text(verbatim: parts.count > 1 ? parts[1] : "")
                } else {
                    Text(verbatim: g.headline)
                }
            }
            .font(.system(size: 17, weight: .bold))
            .foregroundStyle(g.late ? Color.bad : g.dim ? Color.muted : ink)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .widgetAccentable()
            if g.under != nil || g.sure != nil {
                HStack(spacing: 4) {
                    if let under = g.under { Text(verbatim: under).lineLimit(1) }
                    if let sure = g.sure {
                        Text(verbatim: sure).fontWeight(.semibold).foregroundStyle(sure == "~" ? Color.muted : Color.good).layoutPriority(1)
                    }
                }
                .font(.system(size: 14))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
