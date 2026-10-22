@preconcurrency import AVFoundation
import SwiftUI

/// Pair with a code from a signed-in phone or the account page. The code is
/// the screen: six split-flap tiles that fill as it's typed, like a departure
/// board settling. Where to find a code sits under it, then scanning the QR
/// code the account page shows, and Pair at the foot, above the keyboard.
struct PairView: View {
    let model: WelcomeModel
    @State private var code = ""
    @State private var scanning = false
    @FocusState private var focused: Bool

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(L("Pair this phone"))
                    .font(.largeTitle.bold())
                    .accessibilityAddTraits(.isHeader)
                Text(L("Type the code from a phone or computer that's already signed in."))
                    .font(.body)
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 6)
                tiles.padding(.top, 28)
                if let e = model.pairError {
                    Text(e)
                        .font(.subheadline)
                        .foregroundStyle(Color.bad)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)
                        .announced(e)
                        .accessibilityIdentifier("pair.error")
                }
                HStack(alignment: .top, spacing: 10) {
                    WhereCard(icon: "iphone", title: L("On a phone"), how: L("Settings, then Add a device"))
                    if let url = URL(string: Api.linkBase + "/account") {
                        Link(destination: url) {
                            WhereCard(
                                icon: "safari", title: L("On the web"), how: L("%@/account, then Add a device", Api.siteHost), opens: true)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 24)
                if Scanner.hasCamera {
                    Button {
                        focused = false
                        scanning = true
                    } label: {
                        Label(L("Scan the QR code"), systemImage: "qrcode.viewfinder")
                    }
                    .buttonStyle(.secondary)
                    .padding(.top, 14)
                    .accessibilityIdentifier("pair.scan")
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom) {
            Button(model.pairing ? L("Pairing…") : L("Pair")) { model.pair(code) }
                .buttonStyle(.primary)
                .disabled(code.count < SignInCode.length || model.pairing)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(Color.page)
                .accessibilityIdentifier("pair.pair")
        }
        .background(Color.page.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            model.pairError = nil
            focused = true
        }
        .sheet(isPresented: $scanning) {
            ScanSheet { found in
                scanning = false
                code = found
                model.pair(found)
            }
        }
    }

    private var tiles: some View {
        ZStack {
            // The field is there for the keyboard and Paste; the tiles show what's typed.
            TextField(
                "",
                text: Binding(
                    get: { code },
                    set: { new in
                        let clean = SignInCode.edit(old: code, new: new)
                        // The sixth character, typed or pasted, pairs.
                        let full = clean.count == SignInCode.length && code.count < SignInCode.length
                        code = clean
                        if model.pairError != nil { model.pairError = nil }
                        if full { model.pair(clean) }
                    })
            )
            .keyboardType(.asciiCapable)
            .textInputAutocapitalization(.characters)
            .autocorrectionDisabled()
            .submitLabel(.go)
            .onSubmit { model.pair(code) }
            .focused($focused)
            .foregroundStyle(.clear)
            .tint(.clear)
            .accessibilityLabel(L("Pairing code"))
            .accessibilityValue(code.map(String.init).joined(separator: " "))
            .accessibilityIdentifier("pair.code")
            HStack(spacing: 7) {
                let chars = Array(code)
                ForEach(0..<SignInCode.length, id: \.self) { i in
                    Flap(char: i < chars.count ? chars[i] : nil, current: focused && i == chars.count)
                        .frame(maxWidth: 56)
                }
            }
            .frame(maxWidth: .infinity)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
    }
}

/// One character of the code on a split-flap tile: dark in light and dark, as the boards are.
private struct Flap: View {
    let char: Character?
    let current: Bool

    private static let top = Color(rgb: 0x24211E)
    private static let bottom = Color(rgb: 0x1C1A17)
    private static let seam = Color(rgb: 0x0A0908)
    private static let empty = Color(rgb: 0x151311)

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
        ZStack {
            if let char {
                shape.fill(
                    LinearGradient(
                        stops: [
                            .init(color: Self.top, location: 0), .init(color: Self.top, location: 0.49),
                            .init(color: Self.seam, location: 0.49), .init(color: Self.seam, location: 0.51),
                            .init(color: Self.bottom, location: 0.51), .init(color: Self.bottom, location: 1),
                        ], startPoint: .top, endPoint: .bottom))
                Text(String(char))
                    .font(.system(size: 32, weight: .heavy, design: .monospaced))
                    .foregroundStyle(Color(rgb: 0xF2EFEB))
                    .minimumScaleFactor(0.5)
            } else {
                shape.fill(Self.empty)
                if current {
                    Capsule().fill(Color.brand).frame(width: 18, height: 3)
                        .frame(maxHeight: .infinity, alignment: .bottom)
                        .padding(.bottom, 14)
                }
            }
        }
        .aspectRatio(0.72, contentMode: .fit)
        .overlay(shape.strokeBorder(current ? Color.brand : Color(rgb: 0x34302B), lineWidth: current ? 2 : 1))
    }
}

/// Where to find a code: on a phone, or on the web (which opens it).
private struct WhereCard: View {
    let icon: String
    let title: String
    let how: String
    var opens = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Image(systemName: icon).font(.title3).foregroundStyle(Color.brand)
                Spacer()
                if opens { Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint) }
            }
            Text(title).font(.subheadline.weight(.bold)).foregroundStyle(Color.ink).padding(.top, 8)
            Text(how).font(.footnote).foregroundStyle(Color.muted).padding(.top, 2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .cardStyle(padding: 14)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(opens ? .isLink : [])
    }
}

// MARK: scanning

/// The QR code the account page (or another phone) shows, through the camera.
private struct ScanSheet: View {
    let found: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var access = Scanner.access
    @State private var notOurs = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                switch access {
                case .allowed:
                    Scanner { text in
                        if let code = SignInCode.pairCode(scanned: text) {
                            found(code)
                        } else {
                            notOurs = true
                        }
                    }
                    .ignoresSafeArea()
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(.white.opacity(0.9), lineWidth: 3)
                        .frame(width: 240, height: 240)
                        .accessibilityHidden(true)
                    VStack {
                        Spacer()
                        Text(notOurs ? L("That isn't a terminus pairing code.") : L("Point the camera at the QR code on the other device."))
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(.black.opacity(0.55), in: Capsule())
                            .padding(.bottom, 40)
                            .announced(notOurs ? L("That isn't a terminus pairing code.") : nil)
                    }
                case .undecided:
                    ProgressView().tint(.white)
                case .refused:
                    VStack(spacing: 14) {
                        Image(systemName: "camera.fill").font(.largeTitle).foregroundStyle(.white.opacity(0.7))
                        Text(L("terminus can't use the camera. Allow it in Settings, or type the code instead."))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            Link(L("Open Settings"), destination: url).font(.body.weight(.semibold)).foregroundStyle(Color(rgb: 0xFB923C))
                        }
                    }
                    .padding(32)
                }
            }
            .navigationTitle(L("Scan the QR code"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
            }
        }
        .task {
            if access == .undecided {
                access = await AVCaptureDevice.requestAccess(for: .video) ? .allowed : .refused
            }
        }
    }
}

/// The camera's picture, reading QR codes. Each new one read is passed on once.
private struct Scanner: UIViewRepresentable {
    let read: (String) -> Void

    enum Access { case allowed, undecided, refused }

    /// A phone without a camera (the simulator) offers no scanning: typing is the way.
    static var hasCamera: Bool { AVCaptureDevice.default(for: .video) != nil }

    static var access: Access {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: .allowed
        case .notDetermined: .undecided
        default: .refused
        }
    }

    final class Preview: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate, @unchecked Sendable {
        let session = AVCaptureSession()
        var read: (String) -> Void
        private var last: String?

        init(read: @escaping (String) -> Void) { self.read = read }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection)
        {
            guard let text = (objects.first as? AVMetadataMachineReadableCodeObject)?.stringValue, text != last else { return }
            last = text
            // Delivered on the main queue (setMetadataObjectsDelegate below).
            MainActor.assumeIsolated {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                read(text)
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(read: read) }

    func makeUIView(context: Context) -> Preview {
        let view = Preview()
        view.preview.videoGravity = .resizeAspectFill
        let c = context.coordinator
        view.preview.session = c.session
        guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
            c.session.canAddInput(input)
        else { return view }
        c.session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard c.session.canAddOutput(output) else { return view }
        c.session.addOutput(output)
        output.setMetadataObjectsDelegate(c, queue: .main)
        output.metadataObjectTypes = [.qr]
        // Starting the camera takes a moment: off the main thread.
        DispatchQueue.global(qos: .userInitiated).async { c.session.startRunning() }
        return view
    }

    func updateUIView(_ view: Preview, context: Context) {
        context.coordinator.read = read
    }

    static func dismantleUIView(_ view: Preview, coordinator: Coordinator) {
        DispatchQueue.global(qos: .userInitiated).async { coordinator.session.stopRunning() }
    }
}
