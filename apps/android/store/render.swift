// Draws the Play Store icon (512×512) and feature graphic (1024×500) from the
// launcher icon's shapes (res/drawable/ic_launcher_foreground.xml).
//
//   swift apps/android/store/render.swift apps/android/store apps/web/public/assets/icons
import AppKit

let bg = NSColor(srgbRed: 0x1C / 255, green: 0x19 / 255, blue: 0x17 / 255, alpha: 1)
let orange = NSColor(srgbRed: 0xFB / 255, green: 0x92 / 255, blue: 0x3C / 255, alpha: 1)
let paper = NSColor(srgbRed: 0xFA / 255, green: 0xFA / 255, blue: 0xF9 / 255, alpha: 1)
let muted = NSColor(srgbRed: 0xD6 / 255, green: 0xD3 / 255, blue: 0xD1 / 255, alpha: 1)

/// The mark in its own 64×71 box (bar, pole, dot), top-left at `origin`, `unit` points per unit.
func drawMark(at origin: CGPoint, unit u: CGFloat, height canvasH: CGFloat) {
    // AppKit's origin is bottom-left; the vector's is top-left.
    func r(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) -> CGRect {
        CGRect(x: origin.x + x * u, y: canvasH - (origin.y + (y + h) * u), width: w * u, height: h * u)
    }
    orange.setFill()
    NSBezierPath(roundedRect: r(0, 0, 64, 14), xRadius: 7 * u, yRadius: 7 * u).fill()
    // The pole: square top under the bar, round foot.
    NSBezierPath(rect: r(25, 0, 14, 57)).fill()
    NSBezierPath(ovalIn: r(25, 50, 14, 14)).fill()
    paper.setFill()
    NSBezierPath(ovalIn: r(46, 29, 14, 14)).fill()
}

func render(_ w: Int, _ h: Int, to path: String, draw: () -> Void) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                               hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    rep.size = NSSize(width: w, height: h)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    draw()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
    print("wrote \(path)")
}

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."

// Icon: full square (Play rounds the corners and adds no safe-zone mask),
// so the mark is larger than on the launcher, just over half the width. The
// mark's corners stay inside the central 80% circle, so the same drawing is
// the web app's maskable icon too.
func icon(_ size: Int, to path: String) {
    render(size, size, to: path) {
        let s = CGFloat(size)
        bg.setFill()
        NSRect(x: 0, y: 0, width: s, height: s).fill()
        let u = 4.2 * s / 512
        drawMark(at: CGPoint(x: (s - 64 * u) / 2, y: (s - 64 * u) / 2), unit: u, height: s)
    }
}
icon(512, to: "\(out)/icon-512.png")

// The web app's icons (apps/web/public/assets/icons), with a second argument.
if CommandLine.arguments.count > 2 {
    let web = CommandLine.arguments[2]
    icon(192, to: "\(web)/icon-192.png")
    icon(512, to: "\(web)/icon-512.png")
    icon(180, to: "\(web)/apple-touch-icon.png")
}

// Feature graphic: the mark, the wordmark and the promise.
render(1024, 500, to: "\(out)/feature-graphic.png") {
    bg.setFill()
    NSRect(x: 0, y: 0, width: 1024, height: 500).fill()
    drawMark(at: CGPoint(x: 96, y: 150), unit: 3.1, height: 500)

    let word = NSMutableAttributedString(string: "terminus", attributes: [
        .font: NSFont.systemFont(ofSize: 104, weight: .bold), .foregroundColor: paper, .kern: -2,
    ])
    word.addAttribute(.foregroundColor, value: orange, range: NSRange(location: 5, length: 3))
    word.draw(at: NSPoint(x: 360, y: 500 - 118 - 124))

    let para = NSMutableParagraphStyle()
    para.lineSpacing = 6
    let line = NSAttributedString(string: "When to leave for class,\nnot just when the bus comes.", attributes: [
        .font: NSFont.systemFont(ofSize: 38, weight: .medium), .foregroundColor: muted, .paragraphStyle: para,
    ])
    line.draw(in: NSRect(x: 364, y: 500 - 262 - 110, width: 620, height: 110))
}
