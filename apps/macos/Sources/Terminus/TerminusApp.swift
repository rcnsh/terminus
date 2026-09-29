import SwiftUI
import os

/// Creates the model at launch, so refreshing starts even before (or
/// without) SwiftUI ever drawing the menu bar item.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        #if DEBUG
        if let dir = ProcessInfo.processInfo.environment["TERMINUS_SNAPSHOT"] {
            MainActor.assumeIsolated { Snapshots.render(to: dir) }
            exit(0)
        }
        #endif
        MainActor.assumeIsolated { _ = AppModel.shared }
    }
}

@main
struct TerminusApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var model = AppModel.shared

    var body: some Scene {
        MenuBarExtra {
            Popover(model: model)
        } label: {
            // Recomputed from the departure time on the model's 30 s clock,
            // so the menu bar never shows a count that was true two refreshes
            // ago. (A TimelineView here starves app launch.)
            if model.resting {
                Image(systemName: "moon.zzz.fill")
            } else if let title = model.menuTitle(at: model.clock) {
                Label(title, systemImage: "bus.fill").labelStyle(.titleAndIcon)
            } else {
                Image(systemName: "bus.fill")
            }
        }
        .menuBarExtraStyle(.window)
    }
}

// MARK: - Shell

/// A fixed "now" for snapshot renders, which can't run a TimelineView.
struct FixedNowKey: EnvironmentKey { static let defaultValue: Date? = nil }
extension EnvironmentValues {
    var fixedNow: Date? {
        get { self[FixedNowKey.self] }
        set { self[FixedNowKey.self] = newValue }
    }
}

/// Re-renders its content every `every` seconds with the current time.
struct Ticking<Content: View>: View {
    let every: TimeInterval
    @ViewBuilder let content: (Date) -> Content
    @Environment(\.fixedNow) private var fixedNow

    var body: some View {
        if let fixedNow {
            content(fixedNow)
        } else {
            TimelineView(.periodic(from: .now, by: every)) { ctx in content(ctx.date) }
        }
    }
}


struct Popover: View {
    @Bindable var model: AppModel
    /// Drives the opening animation. The popover's window is the only one
    /// this app has, so its key state is exactly "the popover is open".
    @State private var shown: Bool
    @State private var window: NSWindow?

    init(model: AppModel, startShown: Bool = false) {
        self.model = model
        _shown = State(initialValue: startShown)
    }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if model.paired { Main(model: model) } else { Pair(model: model) }
            }
            .padding(14)
            Footer(model: model)
        }
        .frame(width: 360)
        .fixedSize(horizontal: false, vertical: true)
        // The menu bar window grows to fit taller content but never shrinks
        // back on its own, leaving the shorter content centred with a gap
        // above it. Measure the content and size the window to it, top edge
        // pinned under the menu bar.
        .background(GeometryReader { g in Color.clear.preference(key: ContentHeight.self, value: g.size.height) })
        .onPreferenceChange(ContentHeight.self) { h in fit(height: h) }
        // A snapshot has no window, and ImageRenderer can't draw an NSView.
        .background { if !model.isSnapshot { WindowReader { if window !== $0 { window = $0 } } } }
        // Opening is a plain fade of the whole popover; nothing moves.
        .opacity(shown ? 1 : 0)
        .frame(maxHeight: .infinity, alignment: .top)
        .ignoresSafeArea()
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { n in
            if window == nil || n.object as? NSWindow === window { open() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResignKeyNotification)) { n in
            if n.object as? NSWindow === window { close() }
        }
        // The definitive "it's gone": the window stops being visible.
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didChangeOcclusionStateNotification)) { n in
            guard let w = n.object as? NSWindow, w === window, !w.occlusionState.contains(.visible) else { return }
            model.popoverOpen = false
            shown = false
        }
        .onAppear { open() }
    }

    private func open() {
        guard !shown else { return }
        model.popoverOpen = true
        withAnimation(.easeOut(duration: 0.18)) { shown = true }
    }

    /// Losing key status doesn't mean the popover closed: opening the
    /// Settings menu takes key away while the popover stays on screen. Only
    /// treat it as closed once the window has actually gone.
    private func close() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            guard let window, !window.isVisible || !window.occlusionState.contains(.visible) else { return }
            model.popoverOpen = false
            shown = false
        }
    }

    private func fit(height: CGFloat) {
        guard let window, height > 0 else { return }
        let content = window.contentRect(forFrameRect: window.frame)
        guard abs(content.height - height) > 0.5 else { return }
        var frame = window.frameRect(forContentRect: NSRect(x: content.minX, y: content.minY, width: content.width, height: height))
        frame.origin.y = window.frame.maxY - frame.height
        window.setFrame(frame, display: true, animate: false)
    }
}

private struct ContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Hands back the NSWindow this view ends up in.
private struct WindowReader: NSViewRepresentable {
    let found: (NSWindow) -> Void

    init(_ found: @escaping (NSWindow) -> Void) { self.found = found }

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { if let w = v.window { found(w) } }
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { if let w = nsView.window { found(w) } }
    }
}
