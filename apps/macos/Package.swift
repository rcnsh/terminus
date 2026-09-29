// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Terminus",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "Terminus", path: "Sources/Terminus"),
        // Parses the API's golden answers (apps/api/test/fixtures/answers).
        .testTarget(name: "TerminusTests", dependencies: ["Terminus"], path: "Tests/TerminusTests"),
    ]
)
