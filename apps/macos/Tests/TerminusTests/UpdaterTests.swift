import AppKit
import Testing

@testable import Terminus

@Test func anOpenWindowHoldsBackAnUpdate() {
    for id in ["map", "map-AppWindow-1", "settings", "setup", "", "SUUpdateAlert"] {
        #expect(Updater.blocksInstall(id: id, shown: true, level: .normal), "\(id)")
        #expect(!Updater.blocksInstall(id: id, shown: false, level: .normal), "\(id)")
    }
    #expect(!Updater.blocksInstall(id: "", shown: true, level: .statusBar))
    #expect(!Updater.blocksInstall(id: "", shown: true, level: .popUpMenu))
    #expect(!Updater.blocksInstall(id: "popover", shown: true, level: .normal))
}
