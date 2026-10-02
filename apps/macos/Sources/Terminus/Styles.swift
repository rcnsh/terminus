import SwiftUI
import os
import AppKit

/// The site's accent (#c2410c light, #fb923c dark), so the menu bar app
/// looks like the same product as the web and the widget.
extension Color {
    /// "#rrggbb", as the API sends a service's colour; nil for anything else.
    init?(hex: String) {
        guard hex.count == 7, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    static let brand = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(red: 0xFB / 255, green: 0x92 / 255, blue: 0x3C / 255, alpha: 1)
            : NSColor(red: 0xC2 / 255, green: 0x41 / 255, blue: 0x0C / 255, alpha: 1)
    })
    /// "On time", matching the site's --good-ink.
    static let good = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(red: 0x4A / 255, green: 0xDE / 255, blue: 0x80 / 255, alpha: 1)
            : NSColor(red: 0x16 / 255, green: 0x65 / 255, blue: 0x34 / 255, alpha: 1)
    })
    /// Warning amber for "tight", matching the web's --warn.
    static let warn = Color(nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .vibrantDark]) != nil
            ? NSColor(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255, alpha: 1)
            : NSColor(red: 0xB4 / 255, green: 0x53 / 255, blue: 0x09 / 255, alpha: 1)
    })
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
