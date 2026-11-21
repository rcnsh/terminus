import SwiftUI

#if os(iOS)
    import UIKit
#endif

extension Color {
    static let brand = themed(0xC2410C, 0xFB923C)
    static let page = themed(0xFAFAF9, 0x0F0E0D)
    static let surface = themed(0xFFFFFF, 0x1A1816)
    static let surface2 = themed(0xF5F4F2, 0x211F1C)
    static let ink = themed(0x1C1917, 0xF2EFEB)
    static let muted = themed(0x6B6560, 0xA39D97)
    static let faint = themed(0xA8A29E, 0x6F6964)
    static let line = themed(0xE7E5E2, 0x2C2926)
    static let lineStrong = themed(0x8A847E, 0x6F6964)
    static let brandSoft = themed(0xFFF1E6, 0x2A1A0E)
    static let good = themed(0x166534, 0x4ADE80)
    static let warn = themed(0x92400E, 0xFBBF24)
    static let bad = themed(0xB91C1C, 0xF87171)

    init?(hex: String?) {
        guard let v = hex.flatMap(hexRGB) else { return nil }
        self.init(rgb: v)
    }

    init(rgb v: UInt32) {
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    static func themed(_ light: UInt32, _ dark: UInt32) -> Color {
        #if os(iOS)
            Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(rgb: dark) : UIColor(rgb: light) })
        #else
            Color(rgb: dark)
        #endif
    }
}

#if os(iOS)
    extension UIColor {
        convenience init(rgb v: UInt32) {
            self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
        }
    }
#endif

func hexRGB(_ hex: String) -> UInt32? {
    guard hex.count == 7, hex.hasPrefix("#") else { return nil }
    return UInt32(hex.dropFirst(), radix: 16)
}

func inkOn(_ rgb: UInt32?) -> Color {
    guard let v = rgb else { return .white }
    let l = luminance(v)
    let ink = luminance(0x1C1917)
    let white = 1.05 / (l + 0.05)
    let dark = (max(l, ink) + 0.05) / (min(l, ink) + 0.05)
    return white >= dark ? .white : Color(rgb: 0x1C1917)
}

func luminance(_ v: UInt32) -> Double {
    func lin(_ c: UInt32) -> Double {
        let s = Double(c) / 255
        return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * lin((v >> 16) & 0xFF) + 0.7152 * lin((v >> 8) & 0xFF) + 0.0722 * lin(v & 0xFF)
}

func serviceColor(_ hex: String?) -> Color { Color(hex: hex) ?? Color(rgb: 0x8A847E) }

struct BusBadge: View {
    let svc: String
    let color: String?
    var size: CGFloat = 13
    var paid = false
    var even = false

    var body: some View {
        let rgb = color.flatMap(hexRGB) ?? 0x8A847E
        Text(paid ? "\(svc) $" : svc)
            .font(.system(size: size, weight: .heavy))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(inkOn(rgb))
            .frame(minWidth: even ? size * 2.2 : nil)
            .padding(.horizontal, size * 0.42)
            .padding(.vertical, size * 0.12)
            .background(Color(rgb: rgb), in: RoundedRectangle(cornerRadius: size * 0.42, style: .continuous))
            .accessibilityLabel(paid ? L("Public bus %@, fare applies", svc) : L("Bus %@", svc))
    }
}

struct Wordmark: View {
    var size: CGFloat = 22
    var accent: Color = .brand

    var body: some View {
        (Text("termi") + Text("nus").foregroundColor(accent)
            + Text(Api.isBeta ? " BETA" : "").font(.system(size: size * 0.45, weight: .bold)).foregroundColor(accent))
            .font(.system(size: size, weight: .bold))
            .tracking(-0.3)
            .accessibilityLabel(Api.isBeta ? "terminus beta" : "terminus")
    }
}
