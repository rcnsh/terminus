// Renders ../web/public/assets/mark.svg into Support/AppIcon.icns, or with
// a BETA band across the bottom into Support/AppIcon-beta.icns.
//   swift Support/make-icon.swift [beta]
import AppKit

let beta = CommandLine.arguments.dropFirst().first == "beta"

let svg = URL(fileURLWithPath: "../web/public/assets/mark.svg")
guard let mark = NSImage(contentsOf: svg) else { fatalError("can't load \(svg.path)") }
let set = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("AppIcon.iconset")
try? FileManager.default.removeItem(at: set)
try FileManager.default.createDirectory(at: set, withIntermediateDirectories: true)

// macOS icons sit inside a margin: the artwork is ~80% of the canvas.
for (points, scale) in [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)] {
    let px = points * scale
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let inset = CGFloat(px) * 0.1
    mark.draw(in: NSRect(x: inset, y: inset, width: CGFloat(px) - 2 * inset, height: CGFloat(px) - 2 * inset))
    if beta && px >= 32 {
        // The site's accent (#C2410C) band with white type, over the artwork's lower edge.
        let band = NSRect(x: inset, y: inset, width: CGFloat(px) - 2 * inset, height: CGFloat(px) * 0.2)
        NSColor(srgbRed: 0xC2 / 255, green: 0x41 / 255, blue: 0x0C / 255, alpha: 1).setFill()
        NSBezierPath(roundedRect: band, xRadius: band.height * 0.3, yRadius: band.height * 0.3).fill()
        let type: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: band.height * 0.62, weight: .bold), .foregroundColor: NSColor.white, .kern: band.height * 0.06]
        let text = NSAttributedString(string: "BETA", attributes: type)
        let size = text.size()
        text.draw(at: NSPoint(x: band.midX - size.width / 2, y: band.midY - size.height / 2))
    }
    NSGraphicsContext.restoreGraphicsState()
    let name = scale == 1 ? "icon_\(points)x\(points).png" : "icon_\(points)x\(points)@2x.png"
    try rep.representation(using: .png, properties: [:])!.write(to: set.appendingPathComponent(name))
}

let task = Process()
task.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
let out = beta ? "Support/AppIcon-beta.icns" : "Support/AppIcon.icns"
task.arguments = ["-c", "icns", set.path, "-o", out]
try task.run()
task.waitUntilExit()
print(task.terminationStatus == 0 ? "wrote \(out)" : "iconutil failed")
