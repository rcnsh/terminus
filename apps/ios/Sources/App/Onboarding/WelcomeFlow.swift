import SwiftUI

/// Signed out: the welcome screen, then signing in or pairing, each a page
/// pushed over it (swipe back, or Back, to return).
struct WelcomeFlow: View {
    @State private var path: [Page] = []
    @State private var model = WelcomeModel.shared

    enum Page: Hashable { case signIn, pair }

    var body: some View {
        NavigationStack(path: $path) {
            WelcomeView(model: model, open: { path.append($0) })
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(for: Page.self) { page in
                    switch page {
                    case .signIn: SignInView(model: SignInModel()) {}
                    case .pair: PairView(model: model)
                    }
                }
        }
        // A pairing link: whose account it is, and a yes before anything happens.
        .alert(
            L("Pair this phone?"), isPresented: Binding(get: { model.pendingPair != nil }, set: { if !$0 { model.pendingPair = nil } }),
            presenting: model.pendingPair
        ) { p in
            Button(L("Pair")) { model.pair(p.code) }
            Button(L("Cancel"), role: .cancel) { model.pendingPair = nil }
        } message: { p in
            Text(
                L(
                    "This link pairs this phone with %@. Only continue if you created this code on your own account page. A code from someone else would send your trips and location to their account.",
                    p.account))
        }
    }
}

/// First launch: start straight away, or sign in to an account you already
/// have. A bus's livery sweeps across the top, a stripe in each service's
/// colour, with the mark where the fleet number would be; the buttons sit at
/// the foot, under the thumb. It fits the screen; it scrolls only when
/// large text can't fit.
struct WelcomeView: View {
    let model: WelcomeModel
    let open: (WelcomeFlow.Page) -> Void
    @Environment(AppModel.self) private var app

    var body: some View {
        // Fitted to the screen, the livery taking what's left, so there's
        // nothing to drag on any phone; it scrolls only when large text
        // can't fit, rather than cutting the buttons off.
        ViewThatFits(in: .vertical) {
            page(livery: 130...360)
            ScrollView { page(livery: 160...160) }
        }
        .background(Color.page.ignoresSafeArea())
        .statusBar(light: nil)
    }

    private func page(livery: ClosedRange<CGFloat>) -> some View {
        VStack(spacing: 0) {
            LanguageSwitch()
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.horizontal, 12)
            // The livery grows with the screen, so a tall phone isn't left with a gap.
            ZStack(alignment: .bottom) {
                WelcomeLivery()
                TerminusMark()
                    .frame(width: 92, height: 92)
                    .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
                    .padding(6)
                    .background(Color.page, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
            }
            .frame(minHeight: livery.lowerBound, maxHeight: livery.upperBound)
            Wordmark(size: 46)
                .tracking(-1)
                .padding(.top, 16)
            Text(L("When to leave for class, and which bus to catch."))
                .font(.title3)
                .foregroundStyle(Color.muted)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 40)
                .padding(.top, 8)
            HStack(spacing: 6) {
                ForEach(WelcomeLivery.services, id: \.svc) { BusBadge(svc: $0.svc, color: $0.color, size: 13) }
            }
            .padding(.top, 14)
            .accessibilityHidden(true)
            Spacer(minLength: 24)
            actions
        }
    }

    private var busy: Bool { model.starting || model.pairing }

    @ViewBuilder private var actions: some View {
        VStack(spacing: 0) {
            if Outdated.required {
                Banner(text: L("Update terminus to keep using it.")) {}
                    .padding(.bottom, 12)
            }
            // Said as soon as it shows: it's why nothing happened.
            if let m = model.message ?? (model.pendingPair == nil ? model.pairError : nil) ?? app.signedOutReason {
                Text(m)
                    .font(.subheadline)
                    .foregroundStyle(Color.bad)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 12)
                    .announced(m)
            }
            Button(model.starting ? L("Starting…") : L("Get started")) { model.start() }
                .buttonStyle(.primary)
                .disabled(busy)
                .accessibilityIdentifier("welcome.start")
            Text(L("About a minute to set up. No email or sign-in needed."))
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .multilineTextAlignment(.center)
                .padding(.vertical, 10)
            Button(L("I already have an account")) { open(.signIn) }
                .buttonStyle(.secondary)
                .disabled(busy)
                .accessibilityIdentifier("welcome.signIn")
            HStack(spacing: 4) {
                Button(L("Pair with a code instead")) { open(.pair) }
                    .accessibilityIdentifier("welcome.pair")
                    .padding(.horizontal, 10)
                    .frame(minHeight: 44)
                if let url = URL(string: Api.linkBase + "/privacy") {
                    Link(L("Privacy"), destination: url)
                        .foregroundStyle(Color.muted)
                        .padding(.horizontal, 10)
                        .frame(minHeight: 44)
                }
            }
            .font(.subheadline.weight(.medium))
            .padding(.top, 6)
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 12)
    }
}

/// "English · 中文" on the first screen, before there's an account to keep it
/// in. The one in use is the selected one, in the ink; each name is in its own
/// language, so VoiceOver says it in that voice.
private struct LanguageSwitch: View {
    @Environment(Prefs.self) private var prefs

    var body: some View {
        HStack(spacing: 0) {
            ForEach([("en", "English"), ("zh", "中文")], id: \.0) { lang, name in
                let on = (lang == "zh") == Lang.zh
                Button {
                    if !on { prefs.lang = lang }
                } label: {
                    Text(verbatim: name)
                        .font(.subheadline.weight(on ? .semibold : .medium))
                        .foregroundStyle(on ? Color.muted : Color.brand)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                }
                .environment(\.locale, Locale(identifier: lang == "zh" ? "zh-Hans" : "en"))
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityIdentifier("welcome.lang.\(lang)")
            }
        }
    }
}

/// The stripes down a bus's side, rising to the right: one per service (P's
/// grey would dull it), then a gap and a thin line in the accent. Sized by the
/// height it's given, with the rise capped, so a wide screen gets a flatter
/// band rather than a steeper cut.
struct WelcomeLivery: View {
    /// The services as NUS paints them. The API's ROUTE_COLORS (campus.ts) is
    /// the source and every other screen takes them from /api/campus; this one
    /// shows before there's an account to ask with.
    static let services: [(svc: String, color: String)] = [
        ("A1", "#D32F2F"), ("A2", "#D9A000"), ("D1", "#EC4FA0"), ("D2", "#8E44C9"),
        ("K", "#2B9AD6"), ("R1", "#F57C1F"), ("R2", "#34A853"), ("P", "#8A939C"),
    ]

    var body: some View {
        Canvas { g, size in
            let rise = min(size.width * 0.25, 110)
            let unit = size.height / 300
            // The band's lower edge, a fifth of the way up in the middle: the mark sits on it.
            let left = size.height - 60 * unit + rise / 2
            let right = left - rise
            // A strip between two heights above the lower edge, each overlapping
            // the next by a point so no hairline of background shows between them.
            func strip(_ from: CGFloat, _ to: CGFloat, _ color: Color) {
                var p = Path()
                p.move(to: CGPoint(x: 0, y: left - from))
                p.addLine(to: CGPoint(x: size.width, y: right - from))
                p.addLine(to: CGPoint(x: size.width, y: right - to - 1))
                p.addLine(to: CGPoint(x: 0, y: left - to - 1))
                p.closeSubpath()
                g.fill(p, with: .color(color))
            }
            strip(0, 6 * unit, .brand)
            let stripe = 20 * unit
            var at = 16 * unit
            for s in Self.services.filter({ $0.svc != "P" }).reversed() {
                strip(at, at + stripe, Color(hex: s.color) ?? .gray)
                at += stripe
            }
        }
        .accessibilityHidden(true)
    }
}

/// The mark, as the site draws it (assets/mark.svg): an orange T and a white
/// stop on the dark stone, the same in both modes, like the app's icon.
/// Decoration only: the wordmark beside it says the name.
struct TerminusMark: View {
    var body: some View {
        Canvas { g, size in
            // mark.svg's 64-unit grid.
            let u = min(size.width, size.height) / 64
            let orange = Color(rgb: 0xFB923C)
            func rr(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> Path {
                Path(roundedRect: CGRect(x: x * u, y: y * u, width: w * u, height: h * u), cornerRadius: r * u, style: .continuous)
            }
            g.fill(rr(0, 0, 64, 64, 15), with: .color(Color(rgb: 0x1C1917)))
            g.fill(rr(14, 14, 36, 9, 4.5), with: .color(orange))
            g.fill(rr(27.5, 14, 9, 36, 4.5), with: .color(orange))
            g.fill(Path(ellipseIn: CGRect(x: 39.5 * u, y: 32.5 * u, width: 9 * u, height: 9 * u)), with: .color(Color(rgb: 0xFAFAF9)))
        }
        .accessibilityHidden(true)
    }
}
