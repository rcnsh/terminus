// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Terminus",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Updates: checks the appcast, downloads and installs in the background.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "Terminus",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/Terminus"
        ),
        // Parses the API's golden answers (apps/api/test/fixtures/answers).
        .testTarget(name: "TerminusTests", dependencies: ["Terminus"], path: "Tests/TerminusTests"),
    ]
)
