import SwiftUI

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

let columnWidth: CGFloat = 560

extension View {
    func column(gutter: CGFloat = 16, width: CGFloat = columnWidth) -> some View {
        padding(.horizontal, gutter)
            .frame(maxWidth: width, alignment: .leading)
            .frame(maxWidth: .infinity)
    }

    func cardStyle(padding: CGFloat = 16, radius: CGFloat = 18) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.line))
    }

    func announced(_ message: String?) -> some View {
        onAppear { announce(message) }.onChange(of: message) { _, m in announce(m) }
    }
}

@MainActor func announce(_ message: String?) {
    guard let message, !message.isEmpty else { return }
    UIAccessibility.post(notification: .announcement, argument: message)
}

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

struct ChipButtonStyle: ButtonStyle {
    var filled = false
    var wide = false
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
    static let onBrand = themed(0xFFFFFF, 0x1C1917)
}

extension ButtonStyle where Self == PrimaryButtonStyle {
    static var primary: PrimaryButtonStyle { PrimaryButtonStyle() }
}

extension ButtonStyle where Self == SecondaryButtonStyle {
    static var secondary: SecondaryButtonStyle { SecondaryButtonStyle() }
}

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
