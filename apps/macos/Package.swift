// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Terminus",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.0")
    ],
    targets: [
        .executableTarget(
            name: "Terminus",
            dependencies: [.product(name: "Sparkle", package: "Sparkle"), "MapLibre"],
            path: "Sources/Terminus",
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path"])]
        ),
        .binaryTarget(name: "MapLibre", path: "Vendor/MapLibre.xcframework.zip"),
        .testTarget(name: "TerminusTests", dependencies: ["Terminus"], path: "Tests/TerminusTests"),
    ]
)
