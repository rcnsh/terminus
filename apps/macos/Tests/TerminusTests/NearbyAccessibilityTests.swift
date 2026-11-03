import AppKit
import ApplicationServices
import SwiftUI
import Testing

@testable import Terminus

/// Nearby as VoiceOver finds it, read through the accessibility tree (no
/// VoiceOver): each row one element, its second line too when stacked; the
/// columns' heading not there at all; each stop's name before its rows and
/// the foot last; and the times said in words. Asking this process's own
/// tree needs the runner to be trusted for accessibility (System Settings,
/// Privacy & Security, Accessibility), so it's skipped where it isn't (CI).
@MainActor @Suite(.enabled(if: AXIsProcessTrusted()), .serialized)
struct NearbyAccessibilityTests {
    struct Element {
        let role: String
        let label: String
        let value: String
        let children: Int
        var text: String { label.isEmpty ? value : label }
    }

    private let stops = Snapshots.nearbySample(at: parseISODate("2026-11-04T03:55:00Z")!, zh: false)

    @Test func oneLine() throws {
        let elements = tree(width: 336)
        let rows = try check(elements)
        for svc in ["D2", "BTC1"] {
            let label = try #require(rows.first { $0.label.hasPrefix("Bus \(svc), ") }).label
            #expect(!label.contains("catch"), "\(label)")
            #expect(label.contains("about"), "\(label)")
            #expect(label.contains("minute"), "\(label)")
            #expect(!label.contains("~"), "\(label)")
            #expect(label.range(of: #"\bmin\b"#, options: .regularExpression) == nil, "\(label)")
        }
        let d2 = try #require(rows.first { $0.label.hasPrefix("Bus D2, ") }).label
        #expect(d2 == "Bus D2, via PGP, 2 minutes, live, then 14 minutes, then about 26 minutes")
    }

    @Test func stacked() throws {
        // Narrow enough that every row stacks, its times on a second line.
        let width: CGFloat = 200
        #expect(NearbyLayout(stops, rowWidth: width - 20).stacks)
        let rows = try check(tree(width: width))
        #expect(
            rows.first { $0.label.hasPrefix("Bus D2, ") }?.label
                == "Bus D2, via PGP, 2 minutes, live, then 14 minutes, then about 26 minutes"
        )
    }

    /// The order and shape every layout shares; the rows, in order.
    private func check(_ elements: [Element]) throws -> [Element] {
        let board = stops.flatMap(\.board)
        let rows = elements.filter { e in
            board.contains { e.label.hasPrefix("Bus \($0.svc), ") || e.label.hasPrefix("Public bus \($0.svc), ") }
        }
        #expect(rows.count == board.count, "each row one element")
        #expect(rows.allSatisfy { $0.children == 0 }, "nothing inside a row is an element of its own")
        #expect(!elements.contains { $0.role == "AXRadioGroup" }, "minutes only: no switch to clock times")
        #expect(!rows.contains { $0.label.contains(", in ") }, "no clock time's wait: \(rows.map(\.label))")
        let heads = ["Next", "Then", "After"].map { $0.uppercased() }
        #expect(!elements.contains { heads.contains($0.text) }, "the heading isn't read")
        let texts = elements.map(\.text)
        let com3 = try #require(texts.firstIndex(of: "COM 3"))
        let clb = try #require(texts.firstIndex(of: "CLB"))
        let at = { (svc: String) in texts.firstIndex { $0.hasPrefix("Bus \(svc), ") || $0.hasPrefix("Public bus \(svc), ") } ?? -1 }
        #expect(com3 < at("D2") && at("D2") < at("D1") && at("95") < clb && clb < at("A1") && at("A1") < at("BTC1"))
        let foot = try #require(texts.firstIndex { $0.hasPrefix("~ is a guess") })
        #expect(foot > at("BTC1") && texts.lastIndex { $0.hasPrefix("~ is a guess") } == texts.count - 1)
        return rows
    }

    /// Nearby in a window of its own, `width` wide, as the accessibility tree has it: every element, in order.
    private func tree(width: CGFloat) -> [Element] {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        app.finishLaunching()
        let host = NSHostingView(rootView: NearbyList(stops: stops).frame(width: width))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: width, height: 1400), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        // Found by its title in the tree: other tests may have windows open.
        window.title = "nearby-accessibility"
        window.contentView = host
        window.orderFrontRegardless()
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        // The tree is asked for from another thread: this one answers.
        final class Found: @unchecked Sendable {
            var elements: [Element] = []
            var done = false
        }
        let found = Found()
        let pid = getpid()
        Thread.detachNewThread {
            func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
                var v: AnyObject?
                return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
            }
            func walk(_ e: AXUIElement) {
                let children = attr(e, kAXChildrenAttribute) as? [AXUIElement] ?? []
                found.elements.append(
                    Element(
                        role: attr(e, kAXRoleAttribute) as? String ?? "", label: attr(e, kAXDescriptionAttribute) as? String ?? "",
                        value: attr(e, kAXValueAttribute) as? String ?? "", children: children.count))
                children.forEach(walk)
            }
            let app = AXUIElementCreateApplication(pid)
            // Asked once, SwiftUI builds its tree.
            _ = attr(app, kAXWindowsAttribute)
            Thread.sleep(forTimeInterval: 0.3)
            let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
            windows.first { attr($0, kAXTitleAttribute) as? String == "nearby-accessibility" }.map(walk)
            found.done = true
        }
        let deadline = Date().addingTimeInterval(20)
        while !found.done, Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        return found.elements
    }
}
