// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Terminus",
    platforms: [.macOS(.v14)],
    dependencies: [
        // Updates: checks the appcast, downloads and installs in the background.
        // No older than 2.10.0, past the fixes for CVE-2025-10015 and -10016.
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.0"),
    ],
    targets: [
        .executableTarget(
            name: "Terminus",
            dependencies: [.product(name: "Sparkle", package: "Sparkle"), "MapLibre"],
            path: "Sources/Terminus",
            // `swift run` finds the frameworks beside the binary (build.sh adds the app's own rpath).
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path"])]
        ),
        // The campus map: MapLibre Native, built for macOS by
        // scripts/vendor-maplibre-mac.sh (none is published).
        .binaryTarget(name: "MapLibre", path: "Vendor/MapLibre.xcframework.zip"),
        // Parses the API's golden answers (apps/api/test/fixtures/answers).
        .testTarget(name: "TerminusTests", dependencies: ["Terminus"], path: "Tests/TerminusTests"),
    ]
)
