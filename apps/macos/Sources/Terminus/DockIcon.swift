import AppKit

@MainActor
enum DockIcon {
    private static var watching: [NSObjectProtocol] = []

    static func start() {
        guard watching.isEmpty else { return }
        let center = NotificationCenter.default
        let names = [NSWindow.didBecomeKeyNotification, NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification]
        watching = names.map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { update() } }
            }
        }
    }

    private static func update() {
        guard !NSApp.isHidden else { return }
        let policy: NSApplication.ActivationPolicy = Updater.shared.windowOpen ? .regular : .accessory
        guard NSApp.activationPolicy() != policy else { return }
        NSApp.setActivationPolicy(policy)
        if policy == .regular { NSApp.activate() }
    }
}
