import SwiftUI
import AppKit

/// "#rrggbb" as a number (0xRRGGBB); nil for anything else.
func hexRGB(_ hex: String) -> UInt32? {
    guard hex.count == 7, hex.hasPrefix("#") else { return nil }
    return UInt32(hex.dropFirst(), radix: 16)
}

extension NSColor {
    /// An opaque colour from 0xRRGGBB.
    convenience init(rgb v: UInt32) {
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}

extension Color {
    /// "#rrggbb", as the API sends a service's colour; nil for anything else.
    init?(hex: String) {
        guard let v = hexRGB(hex) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    /// The site's accent (#c2410c light, #fb923c dark), so the menu bar app
    /// looks like the same product as the web and the widget.
    static let brand = themed(light: 0xC2410C, dark: 0xFB923C)
    /// "On time", matching the site's --good-ink.
    static let good = themed(light: 0x166534, dark: 0x4ADE80)
    /// Warning amber for "tight", matching the web's --warn.
    static let warn = themed(light: 0xB45309, dark: 0xFBBF24)

    /// One colour in light mode and another in dark, following the appearance.
    private static func themed(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            NSColor(rgb: appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil ? dark : light)
        })
    }
}

/// "termi" + "nus" in the accent, as on the site.
struct Wordmark: View {
    var size: CGFloat = 17
    var body: some View {
        // The beta says so wherever the name is, like the beta site.
        (Text("termi") + Text("nus").foregroundColor(.brand) + Text(Api.isBeta ? " BETA" : "").font(.system(size: size * 0.5, weight: .semibold)).foregroundColor(.brand))
            .font(.system(size: size, weight: .semibold))
            .accessibilityLabel(Api.isBeta ? "terminus beta" : "terminus")
    }
}

extension View {
    /// The inset card every section sits on.
    func card(padding: CGFloat = 12) -> some View {
        self
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.primary.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(.primary.opacity(0.08)))
    }
}

struct SectionLabel: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 11, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(.secondary)
    }
}

/// White or near-black text on a service's colour, whichever reads better
/// (WCAG contrast), as the web and Android pick it.
func inkOn(_ hex: String) -> Color {
    guard let v = hexRGB(hex) else { return .white }
    func lin(_ c: UInt32) -> Double {
        let s = Double(c & 0xFF) / 255
        return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
    }
    let l = 0.2126 * lin(v >> 16) + 0.7152 * lin(v >> 8) + 0.0722 * lin(v)
    // White has luminance 1; #1c1917 about 0.011.
    return (1.05 / (l + 0.05)) >= ((l + 0.05) / 0.061) ? .white : Color(red: 0x1C / 255, green: 0x19 / 255, blue: 0x17 / 255)
}
