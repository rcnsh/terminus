// Draws the terminus mark (../../web/public/assets/mark.svg) as the iPhone
// app's icon: full-bleed on its dark square, which iOS rounds itself. With
// "beta", a BETA band across the bottom, as the Mac's beta icon has.
//   swift Support/make-icon.swift [beta]   (from apps/ios)
import AppKit

let beta = CommandLine.arguments.dropFirst().first == "beta"
let px = 1024
// Opaque, as the App Store wants: no alpha channel in the PNG.
let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 3,
    hasAlpha: false, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 32)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
func rgb(_ v: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
}
// The SVG's 64-unit square, y down, scaled to the canvas.
let u = CGFloat(px) / 64
func box(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSRect {
    NSRect(x: x * u, y: CGFloat(px) - (y + h) * u, width: w * u, height: h * u)
}
rgb(0x1C1917).setFill()
NSRect(x: 0, y: 0, width: px, height: px).fill()
rgb(0xFB923C).setFill()
NSBezierPath(roundedRect: box(14, 14, 36, 9), xRadius: 4.5 * u, yRadius: 4.5 * u).fill()
NSBezierPath(roundedRect: box(27.5, 14, 9, 36), xRadius: 4.5 * u, yRadius: 4.5 * u).fill()
rgb(0xFAFAF9).setFill()
NSBezierPath(ovalIn: box(39.5, 32.5, 9, 9)).fill()
if beta {
    let band = NSRect(x: 0, y: 0, width: CGFloat(px), height: CGFloat(px) * 0.2)
    rgb(0xC2410C).setFill()
    band.fill()
    let type: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: band.height * 0.5, weight: .bold), .foregroundColor: NSColor.white, .kern: band.height * 0.06,
    ]
    let text = NSAttributedString(string: "BETA", attributes: type)
    let size = text.size()
    text.draw(at: NSPoint(x: band.midX - size.width / 2, y: band.midY - size.height / 2))
}
NSGraphicsContext.restoreGraphicsState()
let out = beta ? "Support/Assets.xcassets/AppIcon-Beta.appiconset/icon.png" : "Support/Assets.xcassets/AppIcon.appiconset/icon.png"
try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
