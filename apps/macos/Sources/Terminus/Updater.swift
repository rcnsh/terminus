import AppKit
import Foundation
import Sparkle
import os

/// Updates through Sparkle: checks the appcast every few hours, downloads a
/// new version in the background and installs it when the popover, Settings
/// and Setup are closed, relaunching straight into it. Each update is checked
/// against the EdDSA key in Info.plist (SUPublicEDKey), before the disk image
/// is even opened (SUVerifyUpdateBeforeExtraction), and against this app's
/// code signature, so only a release signed with both the update key and the
/// terminus certificate installs.
///
/// Only runs from a built app in Applications: `swift run` has no bundle to
/// replace, and a translocated copy (opened from Downloads or the DMG) can't
/// be written.
@MainActor
final class Updater: NSObject, SPUUpdaterDelegate {
    static let shared = Updater()

    private let log = Logger(subsystem: "sh.rcn.terminus", category: "update")
    private var controller: SPUStandardUpdaterController?
    /// Sparkle's "install now" for a downloaded update, held while the
    /// popover is open so it doesn't vanish from under the user.
    private var installNow: (() -> Void)?
    private var closeWatch: NSObjectProtocol?

    var running: Bool { controller != nil }

    func start(misplaced: Bool) {
        guard controller == nil, !misplaced, Bundle.main.bundleURL.pathExtension == "app" else { return }
        controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
    }

    /// From Settings or the "terminus x is out" card: check now, with
    /// Sparkle's own window saying what it found.
    func checkNow() {
        // A menu bar app is never active on its own; without this Sparkle's
        // window opens behind whatever the user was using.
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    /// Settings or Setup is open: relaunching would close it mid-edit.
    /// (SwiftUI names each window after its scene's id.)
    private var windowOpen: Bool {
        NSApp.windows.contains { w in
            let id = w.identifier?.rawValue ?? ""
            return w.isVisible && (id.hasPrefix("settings") || id.hasPrefix("setup"))
        }
    }

    /// The popover or a window closed: a waiting update can go in now, if
    /// nothing else is open. Otherwise it waits for the next close, or quit.
    func popoverClosed() {
        guard let installNow, !AppModel.shared.popoverOpen, !windowOpen else { return }
        self.installNow = nil
        log.notice("installing the downloaded update")
        installNow()
    }

    // MARK: SPUUpdaterDelegate (Sparkle calls these on the main thread)

    /// TERMINUS_APPCAST points a test build at another feed (only one on this Mac in a release build).
    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        Api.devOverride("TERMINUS_APPCAST")
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void) -> Bool {
        log.notice("update \(item.displayVersionString, privacy: .public) downloaded")
        installNow = immediateInstallationBlock
        if closeWatch == nil {
            closeWatch = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
                // After the close, once the window no longer counts as visible.
                Task { @MainActor in Updater.shared.popoverClosed() }
            }
        }
        popoverClosed()
        return true
    }

    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        log.error("update stopped: \(error.localizedDescription, privacy: .public)")
    }
}
