import AppKit
import Testing
@testable import Terminus

/// A downloaded update waits while any of the app's windows is open (the
/// map too, whose id names no list), but not for the menu bar item.
@Test func anOpenWindowHoldsBackAnUpdate() {
    for id in ["map", "map-AppWindow-1", "settings", "setup", "", "SUUpdateAlert"] {
        #expect(Updater.blocksInstall(id: id, shown: true, level: .normal), "\(id)")
        #expect(!Updater.blocksInstall(id: id, shown: false, level: .normal), "\(id)")
    }
    // The menu bar item's window (NSStatusBarWindow, at the status bar's level).
    #expect(!Updater.blocksInstall(id: "", shown: true, level: .statusBar))
    #expect(!Updater.blocksInstall(id: "", shown: true, level: .popUpMenu))
    // The debug build's popover in a window.
    #expect(!Updater.blocksInstall(id: "popover", shown: true, level: .normal))
}
