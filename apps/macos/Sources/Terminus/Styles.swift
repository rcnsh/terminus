import AppKit
import SwiftUI

func hexRGB(_ hex: String) -> UInt32? {
    guard hex.count == 7, hex.hasPrefix("#") else { return nil }
    return UInt32(hex.dropFirst(), radix: 16)
}

extension NSColor {
    convenience init(rgb v: UInt32) {
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    init?(hex: String) {
        guard let v = hexRGB(hex) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    static let brand = themed(light: brandRGB.light, dark: brandRGB.dark)
    static let brandRGB: (light: UInt32, dark: UInt32) = (0xC2410C, 0xFB923C)
    static let good = themed(light: 0x166534, dark: 0x4ADE80)
    static let warn = themed(light: 0x92400E, dark: 0xFBBF24)
    static let bad = themed(light: 0xB91C1C, dark: 0xF87171)

    private static func themed(light: UInt32, dark: UInt32) -> Color {
        Color(
            nsColor: NSColor(name: nil) { appearance in
                NSColor(rgb: appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil ? dark : light)
            })
    }
}

struct Wordmark: View {
    var size: CGFloat = 17
    var body: some View {
        (Text("termi") + Text("nus").foregroundColor(.brand)
            + Text(Api.isBeta ? " BETA" : "").font(.system(size: size * 0.5, weight: .semibold)).foregroundColor(.brand))
            .font(.system(size: size, weight: .semibold))
            .accessibilityLabel(Api.isBeta ? "terminus beta" : "terminus")
    }
}

extension View {
    func card(padding: CGFloat = 12) -> some View {
        modifier(Card(padding: padding))
    }

    func announced(_ message: String) -> some View {
        onAppear { announce(message) }.onChange(of: message) { _, m in announce(m) }
    }

    func announced(_ message: String, when key: some Equatable) -> some View {
        onAppear { announce(message) }.onChange(of: key) { _, _ in announce(message) }
    }
}

@MainActor func announce(_ message: String?) {
    guard let message, !message.isEmpty else { return }
    AccessibilityNotification.Announcement(message).post()
}

private struct Card: ViewModifier {
    let padding: CGFloat
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        let more = contrast == .increased
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.primary.opacity(more ? 0.08 : 0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.primary.opacity(more ? 0.35 : 0.08)))
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(.secondary)
            .accessibilityLabel(text)
            .accessibilityAddTraits(.isHeader)
    }
}

func inkOn(_ hex: String) -> Color {
    guard let v = hexRGB(hex) else { return .white }
    return inkOn(rgb: v)
}

func inkOn(rgb v: UInt32) -> Color {
    inkIsWhite(on: v) ? .white : Color(red: 0x1C / 255, green: 0x19 / 255, blue: 0x17 / 255)
}

func inkIsWhite(on v: UInt32) -> Bool {
    func contrast(_ a: Double, _ b: Double) -> Double { (max(a, b) + 0.05) / (min(a, b) + 0.05) }
    let l = luminance(v)
    return contrast(l, 1) >= contrast(l, luminance(0x1C1917))
}

func luminance(_ v: UInt32) -> Double {
    func lin(_ c: UInt32) -> Double {
        let s = Double(c & 0xFF) / 255
        return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin(v >> 16) + 0.7152 * lin(v >> 8) + 0.0722 * lin(v)
}
