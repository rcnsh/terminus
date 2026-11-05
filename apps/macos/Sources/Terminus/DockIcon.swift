import AppKit

/// terminus lives in the menu bar (LSUIElement): no Dock icon, no menus, not
/// in ⌘-Tab. A window of its own (Setup, Settings, the map, Sparkle's) is then
/// lost once another app's covers it, so while one is open the app is an
/// ordinary one, in the Dock and ⌘-Tab with its menus, and goes back to the
/// menu bar alone when the last one closes.
@MainActor
enum DockIcon {
    private static var watching: [NSObjectProtocol] = []

    static func start() {
        guard watching.isEmpty else { return }
        let center = NotificationCenter.default
        // A window can open without becoming key (macOS may turn the activation
        // down), so its coming on screen counts too. Closing one sends willClose
        // while it's still on screen, so look once it's gone.
        let names = [NSWindow.didBecomeKeyNotification, NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification]
        watching = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { update() } }
            }
        }
    }

    private static func update() {
        // Hidden (⌘H), the windows aren't visible but still open: dropping the
        // Dock icon then would leave no way back to them.
        guard !NSApp.isHidden else { return }
        let policy: NSApplication.ActivationPolicy = Updater.shared.windowOpen ? .regular : .accessory
        guard NSApp.activationPolicy() != policy else { return }
        NSApp.setActivationPolicy(policy)
        // The menu bar only shows the app's menus once it's activated as an ordinary app.
        if policy == .regular { NSApp.activate() }
    }
}
