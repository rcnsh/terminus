import SwiftUI
import WidgetKit

/// The card style: Steps or Route as segments, like the theme's, and the
/// chosen one drawn under them with a made-up trip (a D2 from PGP to UTown,
/// leaving in a few minutes), so the choice is made by looking without a
/// card for each. The pick holds for the card on Now and the widgets.
struct SettingsCardStyles: View {
    @Environment(Prefs.self) private var prefs

    private static let styles = ["steps", "route"]

    var body: some View {
        SettingsGroup(title: L("Card style"), hint: L("How the card and widgets show a trip by bus. Only on this phone.")) {
            let chosen = JourneyStyle.of(prefs.cardStyle).rawValue
            SettingSegments(
                label: L("Card style"), options: Self.styles.map { ($0, settingsCardStyleName($0)) },
                selection: Binding(
                    get: { chosen },
                    set: {
                        prefs.cardStyle = $0
                        WidgetCenter.shared.reloadAllTimelines()
                    }), id: "settings.cardStyle"
            )
            .padding(.bottom, -6)
            SettingsHint(hint(chosen))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
            SettingsCardSample(style: chosen)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.page, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line, lineWidth: 1))
                .padding(16)
                .accessibilityHidden(true)
        }
    }

    private func hint(_ style: String) -> String {
        switch style {
        case "route": L("The whole trip as a line, with the times under it.")
        default: L("The trip as a line down the card, as on a route map.")
        }
    }
}

/// The sample trip, in one style: the card Now draws, without the sky, so
/// what's chosen here is what Now shows. As Android's CardStylePicker.
struct SettingsCardSample: View {
    let style: String

    var body: some View {
        // Now ticks every second near the end; here the minute is enough.
        TimelineView(.everyMinute) { tick in
            if let a = Self.answer(tick.date), let j = a.card?.journey {
                VStack(alignment: .leading, spacing: 4) {
                    JourneyTop(answer: a, journey: j, style: JourneyStyle.of(style), now: tick.date)
                    JourneyGround(answer: a, journey: j, style: JourneyStyle.of(style), now: tick.date, road: false)
                }
                .foregroundStyle(Color.ink)
            }
        }
    }

    /// A D2 from PGP to UTown, leaving in 4 min, with an A1 three minutes
    /// after it: decoded as the server's answer would be, its words left for
    /// the app to put, in the account's clock style.
    static func answer(_ now: Date) -> NextAnswer? {
        let leave = now.addingTimeInterval(4 * 60)
        let board = leave.addingTimeInterval(4 * 60)
        let arrive = board.addingTimeInterval(8 * 60)
        let backup = board.addingTimeInterval(3 * 60)
        let iso = ISO8601DateFormatter()
        let min = { (n: Int) in L("%@ min", "\(n)") }
        let json: [String: Any] = [
            "label": "D2", "detail": "", "stop": ["code": "PGP", "name": "PGP"], "quality": "live", "asOf": iso.string(from: now),
            "mode": "trip", "dest": ["label": "UTown", "why": "place"], "departsAt": iso.string(from: board),
            "leave": ["at": iso.string(from: leave)],
            "card": [
                "kind": "trip", "late": false, "phase": "idle",
                "journey": [
                    "leave": campusTime(leave), "walk": min(4),
                    "bus": ["svc": "D2", "color": "#8E44C9", "stop": "PGP", "board": campusTime(board)],
                    "boardAt": iso.string(from: board), "ride": min(8), "to": "UTown", "toStop": "UTown",
                    "arrive": campusTime(arrive), "live": true,
                    "backup": ["svc": "A1", "color": "#D32F2F", "stop": "PGP", "board": campusTime(backup)],
                ] as [String: Any],
            ] as [String: Any],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: json) else { return nil }
        return try? JSONDecoder().decode(NextAnswer.self, from: data)
    }
}
