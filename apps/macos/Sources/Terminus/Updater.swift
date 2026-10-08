import AppKit
import Foundation
import Observation
import Sparkle
import os

/// Updates through Sparkle: checks the appcast every few hours, downloads a
/// new version in the background and installs it once the popover and every
/// window (Settings, Setup, the map) are closed, relaunching straight into
/// it. Each update is checked against the EdDSA key in Info.plist
/// (SUPublicEDKey), before the disk image is even opened
/// (SUVerifyUpdateBeforeExtraction), and against this app's code signature,
/// so only a release signed with both the update key and the terminus
/// certificate installs. Stable and beta share the key; each app only reads
/// its own feed (SUFeedURL).
///
/// Only runs from a built app in Applications: `swift run` has no bundle to
/// replace, and a translocated copy (opened from Downloads or the DMG) can't
/// be written.
@MainActor
@Observable
final class Updater: NSObject, SPUUpdaterDelegate {
    static let shared = Updater()

    @ObservationIgnored private let log = Logger(subsystem: "sh.rcn.terminus", category: "update")
    private var controller: SPUStandardUpdaterController?
    /// Sparkle's "install now" for a downloaded update, held while the
    /// popover is open so it doesn't vanish from under the user.
    @ObservationIgnored private var installNow: (() -> Void)?
    @ObservationIgnored private var closeWatch: NSObjectProtocol?
    /// The popover's own window, which `popoverOpen` covers.
    @ObservationIgnored weak var popoverWindow: NSWindow?
    /// Settings' switches. Sparkle keeps the choice in its own defaults, over
    /// Info.plist's (both on).
    private(set) var checksAutomatically = false
    private(set) var installsAutomatically = false

    var running: Bool { controller != nil }

    func start(misplaced: Bool) {
        guard controller == nil, !misplaced, Bundle.main.bundleURL.pathExtension == "app" else { return }
        let controller = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil)
        self.controller = controller
        checksAutomatically = controller.updater.automaticallyChecksForUpdates
        installsAutomatically = controller.updater.automaticallyDownloadsUpdates
    }

    /// Off, nothing is fetched until "Check for updates"; the popover still
    /// says when a new version is out (from latest.json).
    func setChecksAutomatically(_ on: Bool) {
        guard let controller else { return }
        controller.updater.automaticallyChecksForUpdates = on
        checksAutomatically = controller.updater.automaticallyChecksForUpdates
    }

    /// Off, Sparkle asks in its own window before downloading an update.
    func setInstallsAutomatically(_ on: Bool) {
        guard let controller else { return }
        controller.updater.automaticallyDownloadsUpdates = on
        installsAutomatically = controller.updater.automaticallyDownloadsUpdates
    }

    /// From Settings or the "terminus x is out" card: check now, with
    /// Sparkle's own window saying what it found.
    func checkNow() {
        // A menu bar app is never active on its own; without this Sparkle's
        // window opens behind whatever the user was using.
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    /// A window is open (Settings, Setup, the map, Sparkle's own): relaunching
    /// would close it from under the user.
    private var windowOpen: Bool {
        NSApp.windows.contains { w in
            w !== popoverWindow
                && Self.blocksInstall(id: w.identifier?.rawValue ?? "", shown: w.isVisible || w.isMiniaturized, level: w.level)
        }
    }

    /// Whether a window holds back an install: any ordinary one, on screen
    /// or in the Dock, whatever its scene, so a window added later counts
    /// without a list to keep. The menu bar item's window sits above the
    /// normal level; the debug window "popover" is the popover. (SwiftUI
    /// names each window after its scene's id.)
    nonisolated static func blocksInstall(id: String, shown: Bool, level: NSWindow.Level) -> Bool {
        shown && level == .normal && !id.hasPrefix("popover")
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
