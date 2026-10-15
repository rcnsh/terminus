import SwiftUI
import UIKit

/*
 * The parts every page of Settings is made of, as on Android (SettingsParts.kt)
 * and the web (settings-pages.js): the page's title in a band of the sky, then
 * groups down the page, each a small grey heading in capitals, a card of rows
 * and at most one grey line under it. A row is a name, maybe a line under it,
 * and one control on the right. Red is only for deleting the account.
 */

/// A page of Settings: its title (with Back, off the list) in the sky's band,
/// then `content` down the page, scrolling together.
struct SettingsScaffold<Content: View>: View {
    let title: String
    var back = true
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                SkyBand(moonLow: back) { header }
                VStack(alignment: .leading, spacing: 22) { content }
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
                    .padding(.bottom, 40)
            }
        }
        .background(Color.page)
        .scrollDismissesKeyboard(.interactively)
        .skyStatusBar()
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBack())
    }

    private var header: some View {
        HStack(spacing: 6) {
            if back {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.backward")
                        .font(.title3.weight(.semibold))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(L("Back"))
                .accessibilityIdentifier("settings.back")
                .padding(.leading, -10)
            }
            Text(title)
                .font(back ? .title2.weight(.bold) : .largeTitle.weight(.bold))
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 16)
        .padding(.top, back ? 4 : 10)
    }
}

/// A group's heading, its rows in one card, and at most one line under them.
struct SettingsGroup<Content: View>: View {
    var title: String?
    var hint: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { SectionLabel(title).padding(.horizontal, 4) }
            VStack(alignment: .leading, spacing: 0) { content }
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
            if let hint { SettingsHint(hint).padding(.horizontal, 4) }
        }
    }
}

/// A line between rows of a group, from the text's edge, as iOS draws them.
struct GroupDivider: View {
    var inset: CGFloat = 16
    var body: some View { Rectangle().fill(Color.line).frame(height: 1).padding(.leading, inset) }
}

/// A setting's explanation, under it.
struct SettingsHint: View {
    let text: String
    var color: Color = .muted
    init(_ text: String, color: Color = .muted) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text).font(.footnote).foregroundStyle(color).fixedSize(horizontal: false, vertical: true)
    }
}

/// One setting: its name (and a line under it), then its control.
struct SettingRow<Control: View>: View {
    let label: String
    var sub: String?
    @ViewBuilder var control: Control

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).foregroundStyle(Color.ink)
                if let sub { SettingsHint(sub) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            control
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
    }
}

/// A switch with its name and a line under it; the whole row is the target.
struct SettingSwitch: View {
    let label: String
    var sub: String?
    @Binding var isOn: Bool
    var id: String?

    var body: some View {
        Toggle(isOn: $isOn) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).foregroundStyle(Color.ink)
                if let sub { SettingsHint(sub) }
            }
        }
        .tint(.brand)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
        .accessibilityIdentifier(id ?? label)
    }
}

/// A row that opens something: in the app (›) or `away` in Safari (↗).
struct SettingLink: View {
    let title: String
    var sub: String?
    var away = false
    var color: Color = .ink
    var id: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).foregroundStyle(color)
                    if let sub { SettingsHint(sub) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: away ? "arrow.up.right" : "chevron.forward")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.faint)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(SettingsRowPressStyle())
        .accessibilityHint(away ? L("Opens in Safari") : "")
        .accessibilityIdentifier(id ?? title)
    }
}

/// The last row of a list: "+ Add …".
struct SettingsAddRow: View {
    let title: String
    var id: String?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: "plus")
                    .font(.footnote.weight(.bold))
                    .foregroundStyle(Color.brand)
                    .frame(width: 26, height: 26)
                    .background(Color.brandSoft, in: Circle())
                Text(title).fontWeight(.medium).foregroundStyle(Color.brand)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(SettingsRowPressStyle())
        .accessibilityIdentifier(id ?? title)
    }
}

/// Remove, quietly: grey, not the accent.
struct QuietRemove: View {
    var title: String?
    /// What VoiceOver says, naming what goes ("Remove Gym").
    let says: String
    let action: () -> Void

    var body: some View {
        Button(title ?? L("Remove"), action: action)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.muted)
            .buttonStyle(.borderless)
            .padding(.horizontal, 6)
            .frame(minHeight: 44)
            .accessibilityLabel(says)
    }
}

/// A row's own highlight while it's held, as a list row's.
struct SettingsRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? Color.surface2 : Color.clear)
    }
}

/// The page's main action, in the ink, as the chosen chip on Now is (Android's InkButton).
struct SettingsInkButtonStyle: ButtonStyle {
    var full = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(Color.page)
            .padding(.horizontal, 20)
            .frame(maxWidth: full ? .infinity : nil, minHeight: 46)
            .background(Color.ink.opacity(enabled ? 1 : 0.3), in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Capsule())
    }
}

/// Two or three choices as segments: auto, light, dark.
struct SettingSegments: View {
    let label: String
    let options: [(String, String)]
    @Binding var selection: String
    var id: String

    var body: some View {
        Picker(label, selection: $selection) {
            ForEach(options, id: \.0) { Text($0.1).tag($0.0) }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier(id)
        .padding(16)
    }
}

/// What happened (a save refused, data exported), floating at the foot with Undo where there's one.
struct SettingsToast: View {
    let model: SettingsModel

    var body: some View {
        if let text = model.message {
            HStack(spacing: 12) {
                Text(text).font(.subheadline).foregroundStyle(Color.page).frame(maxWidth: .infinity, alignment: .leading)
                if model.undo != nil {
                    Button(L("Undo")) { model.undoLast() }
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(Color.brand)
                        .accessibilityIdentifier("settings.undo")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color.ink, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .onTapGesture { model.dismissMessage() }
            .task(id: text) {
                try? await Task.sleep(for: .seconds(model.undo == nil ? 4 : 6))
                if model.message == text { withAnimation { model.dismissMessage() } }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("settings.toast")
        }
    }
}

/// The email's first letter on a disc in the accent, for the account.
struct AccountInitial: View {
    let email: String
    var size: CGFloat = 44

    var body: some View {
        Text(email.prefix(1).uppercased())
            .font(.system(size: size * 0.42, weight: .heavy))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color.brand, in: Circle())
            .accessibilityHidden(true)
    }
}

/// The app's mark: a bus stop's sign in the accent, where there's no email to show.
struct SettingsMark: View {
    var size: CGFloat = 44

    var body: some View {
        Image(systemName: "bus.fill")
            .font(.system(size: size * 0.44, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(Color.brand, in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

// MARK: times and days

enum SettingsTime {
    /// "9:30 AM" or "09:30" for minutes past midnight, in the account's clock style.
    static func clock(_ min: Int) -> String {
        let f = DateFormatter()
        f.locale = Lang.locale
        f.timeZone = TimeZone(identifier: "UTC")!
        f.setLocalizedDateFormatFromTemplate(Clock.hour12 ? "hmm" : "HHmm")
        return f.string(from: Date(timeIntervalSince1970: TimeInterval(min * 60)))
            .replacingOccurrences(of: #"([上下]午)(\d)"#, with: "$1 $2", options: .regularExpression)
    }

    /// "Mon" in the app's language; `day` is 0 for Sunday, as the profile keeps it.
    static func dayShort(_ day: Int) -> String { weekday(day, short: true) }
    static func dayLong(_ day: Int) -> String { weekday(day, short: false) }

    private static func weekday(_ day: Int, short: Bool) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.locale = Lang.locale
        return (short ? cal.shortWeekdaySymbols : cal.weekdaySymbols)[((day % 7) + 7) % 7]
    }

    /// Minutes past midnight as a date the time pickers can show, in UTC, so no zone moves it.
    static func date(_ min: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(min * 60)) }

    static func minutes(_ d: Date) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.hour, .minute], from: d)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    /// The app's language, with the account's 12- or 24-hour clock, for the time pickers.
    static var pickerLocale: Locale {
        var c = Locale.Components(locale: Lang.locale)
        c.hourCycle = Clock.hour12 ? .oneToTwelve : .zeroToTwentyThree
        return Locale(components: c)
    }
}

/// "1 class", "12 classes"; "No classes yet".
func settingsClassCount(_ n: Int) -> String {
    switch n {
    case 0: L("No classes yet")
    case 1: L("1 class")
    default: L("%@ classes", "\(n)")
    }
}

func settingsDeviceCount(_ n: Int) -> String { n == 1 ? L("1 device") : L("%@ devices", "\(n)") }

/// ", " between items, "、" in Chinese.
var settingsListSep: String { L(", ") }

/// Opens a page on the web, out of the app.
@MainActor func openInSafari(_ url: String) {
    if let u = URL(string: url) { UIApplication.shared.open(u) }
}

// MARK: swiping back

/// The page's own title replaces the navigation bar, which takes the edge
/// swipe back with it; this gives the swipe back to the stack it's in.
struct SwipeBack: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> Controller { Controller() }
    func updateUIViewController(_ vc: Controller, context: Context) {}

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            navigationController?.interactivePopGestureRecognizer?.delegate = self
            navigationController?.interactivePopGestureRecognizer?.isEnabled = true
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            (navigationController?.viewControllers.count ?? 0) > 1
        }
    }
}
