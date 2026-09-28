// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Nusbus",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Nusbus", path: "Sources/Nusbus"),
    ]
)
