import AppKit
import Foundation
import Observation
import Sparkle
import os

@MainActor
@Observable
final class Updater: NSObject, SPUUpdaterDelegate {
    static let shared = Updater()

    @ObservationIgnored private let log = Logger(subsystem: "sh.rcn.terminus", category: "update")
    private var controller: SPUStandardUpdaterController?
    @ObservationIgnored private var installNow: (() -> Void)?
    @ObservationIgnored private var closeWatch: NSObjectProtocol?
    @ObservationIgnored weak var popoverWindow: NSWindow?
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

    func setChecksAutomatically(_ on: Bool) {
        guard let controller else { return }
        controller.updater.automaticallyChecksForUpdates = on
        checksAutomatically = controller.updater.automaticallyChecksForUpdates
    }

    func setInstallsAutomatically(_ on: Bool) {
        guard let controller else { return }
        controller.updater.automaticallyDownloadsUpdates = on
        installsAutomatically = controller.updater.automaticallyDownloadsUpdates
    }

    func checkNow() {
        NSApp.activate(ignoringOtherApps: true)
        controller?.checkForUpdates(nil)
    }

    var windowOpen: Bool {
        NSApp.windows.contains { w in
            w !== popoverWindow
                && Self.blocksInstall(id: w.identifier?.rawValue ?? "", shown: w.isVisible || w.isMiniaturized, level: w.level)
        }
    }

    nonisolated static func blocksInstall(id: String, shown: Bool, level: NSWindow.Level) -> Bool {
        shown && level == .normal && !id.hasPrefix("popover")
    }

    func popoverClosed() {
        guard let installNow, !AppModel.shared.popoverOpen, !windowOpen else { return }
        self.installNow = nil
        log.notice("installing the downloaded update")
        installNow()
    }

    nonisolated func feedURLString(for updater: SPUUpdater) -> String? {
        Api.devOverride("TERMINUS_APPCAST")
    }

    func updater(_ updater: SPUUpdater, willInstallUpdateOnQuit item: SUAppcastItem, immediateInstallationBlock: @escaping () -> Void)
        -> Bool
    {
        log.notice("update \(item.displayVersionString, privacy: .public) downloaded")
        installNow = immediateInstallationBlock
        if closeWatch == nil {
            closeWatch = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { _ in
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
