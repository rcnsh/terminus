import SwiftUI
import UIKit

struct SettingsScaffold<Content: View>: View {
    let title: String
    var back = true
    @ViewBuilder var content: Content
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.paneRoot) private var paneRoot
    @State private var scrolled = false
    @State private var safeTop: CGFloat = 60
    private let clock = SkyClock.shared

    init(title: String, back: Bool = true, @ViewBuilder content: () -> Content) {
        self.title = title
        self.back = back
        self.content = content()
    }

    private var pushed: Bool { back && !paneRoot }

    var body: some View {
        let skyLight = SkyPalette.of(clock.phase, dark: scheme == .dark).lightInk
        ScrollView {
            VStack(spacing: 0) {
                band
                    .background {
                        GeometryReader { g in
                            let under = g.frame(in: .global).maxY < safeTop + 12
                            Color.clear
                                .onAppear { scrolled = under }
                                .onChange(of: under) { _, u in withAnimation(.easeOut(duration: 0.15)) { scrolled = u } }
                        }
                    }
                VStack(alignment: .leading, spacing: 22) { content }
                    .column()
                    .padding(.top, 14)
                    .padding(.bottom, 40)
            }
        }
        .background(Color.page)
        .overlay(alignment: .top) {
            GeometryReader { g in
                VStack(spacing: 0) {
                    Color.page.frame(height: g.safeAreaInsets.top)
                    Color.line.frame(height: 1)
                }
                .ignoresSafeArea(edges: .top)
                .opacity(scrolled ? 1 : 0)
                .allowsHitTesting(false)
                .onAppear { safeTop = g.safeAreaInsets.top }
            }
            .frame(height: 0)
        }
        .scrollDismissesKeyboard(.interactively)
        .statusBar(light: scrolled ? scheme == .dark : skyLight)
        .toolbar(.hidden, for: .navigationBar)
        .background(SwipeBack())
    }

    @ViewBuilder private var band: some View {
        if pushed {
            SkyBand(moonLow: true) {
                HStack(spacing: 6) {
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
                    Text(title)
                        .font(.title2.weight(.bold))
                        .accessibilityAddTraits(.isHeader)
                }
                .column()
                .padding(.top, 4)
            }
        } else {
            TabBand(title: title)
        }
    }
}

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

struct GroupDivider: View {
    var inset: CGFloat = 16
    var body: some View { Rectangle().fill(Color.line).frame(height: 1).padding(.leading, inset) }
}

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

struct SettingRow<Control: View>: View {
    let label: String
    var sub: String?
    @ViewBuilder var control: Control
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        let layout =
            type.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10)) : AnyLayout(HStackLayout(spacing: 12))
        layout {
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

struct QuietRemove: View {
    var title: String?
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

struct SettingsRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? Color.surface2 : Color.clear)
    }
}

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

struct AccountInitial: View {
    let email: String
    var size: CGFloat = 44

    var body: some View {
        Text(email.prefix(1).uppercased())
            .font(.system(size: size * 0.42, weight: .heavy))
            .foregroundStyle(Color.onBrand)
            .frame(width: size, height: size)
            .background(Color.brand, in: Circle())
            .accessibilityHidden(true)
    }
}

struct SettingsMark: View {
    var size: CGFloat = 44

    var body: some View {
        Canvas { ctx, box in
            let u = min(box.width, box.height) / 64
            let orange = Color(red: 0xFB / 255, green: 0x92 / 255, blue: 0x3C / 255)
            func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> Path {
                Path(roundedRect: CGRect(x: x * u, y: y * u, width: w * u, height: h * u), cornerRadius: r * u, style: .continuous)
            }
            ctx.fill(rect(0, 0, 64, 64, 15), with: .color(Color(red: 0x1C / 255, green: 0x19 / 255, blue: 0x17 / 255)))
            ctx.fill(rect(14, 14, 36, 9, 4.5), with: .color(orange))
            ctx.fill(rect(27.5, 14, 9, 36, 4.5), with: .color(orange))
            ctx.fill(
                Path(ellipseIn: CGRect(x: 39.5 * u, y: 32.5 * u, width: 9 * u, height: 9 * u)),
                with: .color(Color(red: 0xFA / 255, green: 0xFA / 255, blue: 0xF9 / 255)))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

enum SettingsTime {
    static func clock(_ min: Int) -> String {
        clockText(Date(timeIntervalSince1970: TimeInterval(min * 60)), in: TimeZone(identifier: "UTC")!)
    }

    static func dayShort(_ day: Int) -> String { weekday(day, short: true) }
    static func dayLong(_ day: Int) -> String { weekday(day, short: false) }

    private static func weekday(_ day: Int, short: Bool) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.locale = Lang.locale
        return (short ? cal.shortWeekdaySymbols : cal.weekdaySymbols)[((day % 7) + 7) % 7]
    }

    static func date(_ min: Int) -> Date { Date(timeIntervalSince1970: TimeInterval(min * 60)) }

    static func minutes(_ d: Date) -> Int {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let c = cal.dateComponents([.hour, .minute], from: d)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    static var pickerLocale: Locale {
        var c = Locale.Components(locale: Lang.locale)
        c.hourCycle = Clock.hour12 ? .oneToTwelve : .zeroToTwentyThree
        return Locale(components: c)
    }
}

func settingsClassCount(_ n: Int) -> String {
    switch n {
    case 0: L("No classes yet")
    case 1: L("1 class")
    default: L("%@ classes", "\(n)")
    }
}

func settingsDeviceCount(_ n: Int) -> String { n == 1 ? L("1 device") : L("%@ devices", "\(n)") }

var settingsListSep: String { L(", ") }

@MainActor func openInSafari(_ url: String) {
    if let u = URL(string: url) { UIApplication.shared.open(u) }
}

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
