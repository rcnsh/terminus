import SwiftUI

/// The small pieces every screen is built from, so the tabs look like one app
/// and like the Android app and the web: the same capsule buttons, cards on
/// the page, pills and section labels.

/// Words in a colour of their own on a tint of it: "On time", "Crowding: low".
struct Pill: View {
    let text: String
    var color: Color = .muted

    var body: some View {
        Text(text)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
    }
}

/// A section's name, small and upper case, above what it names ("MOST COMMON").
struct SectionLabel: View {
    let text: String
    var color: Color = .muted

    init(_ text: String, color: Color = .muted) {
        self.text = text
        self.color = color
    }

    var body: some View {
        Text(text.uppercased(with: Lang.locale))
            .font(.caption.weight(.semibold))
            .tracking(0.8)
            .foregroundStyle(color)
            .accessibilityAddTraits(.isHeader)
    }
}

extension View {
    /// A card on the page: the surface colour, a hairline and rounded corners.
    func cardStyle(padding: CGFloat = 16, radius: CGFloat = 18) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.line))
    }

    /// Says `message`, which this view shows, to VoiceOver when it appears and when it changes.
    func announced(_ message: String?) -> some View {
        onAppear { announce(message) }.onChange(of: message) { _, m in announce(m) }
    }
}

/// Says `message` to VoiceOver now; nothing for nil or empty.
@MainActor func announce(_ message: String?) {
    guard let message, !message.isEmpty else { return }
    UIAccessibility.post(notification: .announcement, argument: message)
}

/// The filled capsule for the one thing a screen is for ("Continue", "Get started").
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(enabled ? Color.onBrand : Color.faint)
            .frame(maxWidth: .infinity, minHeight: 52)
            .padding(.horizontal, 16)
            .background(enabled ? Color.brand : Color.surface2, in: Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
            .contentShape(Capsule())
    }
}

/// The outlined capsule for the other choice beside it ("I already have an account").
struct SecondaryButtonStyle: ButtonStyle {
    var full = true
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .multilineTextAlignment(.center)
            .foregroundStyle(enabled ? Color.ink : Color.faint)
            .frame(maxWidth: full ? .infinity : nil, minHeight: 48)
            .padding(.horizontal, 18)
            .background(Color.surface.opacity(configuration.isPressed ? 0.6 : 1), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.line, lineWidth: 1))
            .contentShape(Capsule())
    }
}

/// A smaller filled or outlined capsule, for buttons that sit in a row ("Not going", "Undo").
struct ChipButtonStyle: ButtonStyle {
    var filled = false
    /// Across the rest of its row, and taller: the one thing to do (directions, "Go there").
    var wide = false
    /// An equal share of its row with the buttons beside it, narrower inside so three fit.
    var even = false
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .multilineTextAlignment(.center)
            .foregroundStyle(filled ? Color.onBrand : (enabled ? Color.ink : Color.faint))
            .padding(.horizontal, even ? 8 : 16)
            .frame(maxWidth: wide || even ? .infinity : nil, minHeight: wide ? 48 : 40)
            .background(filled ? (enabled ? Color.brand : Color.faint) : Color.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(filled ? Color.clear : Color.line))
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Capsule())
    }
}

extension Color {
    /// Words on the accent: white on the light theme's deep orange, the dark ink on the dark theme's light one, as on Android.
    static let onBrand = themed(0xFFFFFF, 0x1C1917)
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

/// A notice above what it's about: an update, location being off, a failure.
struct Banner<Actions: View>: View {
    let text: String
    var tint: Color = .brand
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(text).font(.subheadline).foregroundStyle(Color.ink)
            actions
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
