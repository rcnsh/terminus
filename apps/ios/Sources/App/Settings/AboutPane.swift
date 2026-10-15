import SwiftUI

/// Settings › About: the app's mark, name and version; what it is, that it
/// isn't NUS's, and where its data comes from; then its links and the
/// licences. The version, tapped seven times, shows the developer settings
/// (always there in debug and beta builds), as Android's build number does.
struct SettingsAboutPane: View {
    let model: SettingsModel
    @State private var developer = Servers.menuShown
    @State private var taps = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                SettingsMark()
                VStack(alignment: .leading, spacing: 2) {
                    Wordmark(size: 20)
                    Text(L("Version %@", Api.version))
                        .font(.footnote)
                        .foregroundStyle(Color.muted)
                        .contentShape(Rectangle())
                        .onTapGesture(perform: tapVersion)
                        .accessibilityAddTraits(.isStaticText)
                        .accessibilityIdentifier("settings.version")
                }
            }
            Text(L("terminus tells you which NUS shuttle bus to catch, from which stop, and when to leave, from your NUSMods timetable."))
                .foregroundStyle(Color.ink)
                .fixedSize(horizontal: false, vertical: true)
            SettingsHint(
                L(
                    "terminus is an independent student project, not affiliated with NUS. Live bus times come from NUS. Walking routes and the map use data from OpenStreetMap contributors."
                ))
        }
        .padding(.horizontal, 4)
        SettingsGroup(title: L("More"), hint: L("Use terminus in line with the NUS Acceptable Use Policy for IT Resources.")) {
            ForEach(Array(links.enumerated()), id: \.offset) { i, link in
                if i > 0 { GroupDivider() }
                SettingLink(title: link.0, sub: link.2, away: true) { openInSafari(link.1) }
            }
            GroupDivider()
            SettingLink(title: L("Licences"), sub: L("MapLibre, OpenStreetMap and the rest"), id: "settings.licences") {
                model.path.append(.licences)
            }
        }
        if developer { DeveloperGroup() }
    }

    /// Each link's name, where it goes (the address kept for good, as the
    /// other apps do), and that place as people know it.
    private var links: [(String, String, String)] {
        let host = Api.siteHost
        let base = Api.linkBase
        return [
            (L("Get the apps"), base, host),
            (L("Status"), "\(base)/status", "\(host)/status"),
            (L("Privacy"), "\(base)/privacy", "\(host)/privacy"),
            (L("API docs"), "\(base)/docs", "\(host)/docs"),
            (L("Source code"), "https://github.com/rcnsh/terminus", "github.com/rcnsh/terminus"),
            (L("Map data"), "https://www.openstreetmap.org/copyright", "openstreetmap.org"),
            (L("NUS Acceptable Use Policy"), "https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf", "nus.edu.sg"),
        ]
    }

    private func tapVersion() {
        guard !developer else { return }
        taps += 1
        if taps >= Servers.unlockTaps {
            Servers.unlockMenu()
            withAnimation { developer = true }
            model.say(L("Developer settings are on, at the bottom of About."))
        }
    }
}

/// Which server the app talks to, from the ones built in (Servers). Each
/// keeps its own sign-in, so the app starts again on the one chosen.
private struct DeveloperGroup: View {
    @State private var chosen = Servers.current
    @Environment(AppModel.self) private var app

    var body: some View {
        SettingsGroup(
            title: L("Developer"),
            hint: L(
                "Which server this app talks to. Only terminus's own are here. Switching to or from the dev stub keeps each one's sign-in apart."
            )
        ) {
            ForEach(Array(Servers.choices.enumerated()), id: \.element) { i, base in
                if i > 0 { GroupDivider() }
                Button {
                    guard base != chosen else { return }
                    Servers.choose(base)
                    chosen = base
                    restart()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(
                                verbatim: base.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
                            ).foregroundStyle(Color.ink)
                            if let sub = sub(base, first: i == 0) { SettingsHint(sub) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if base == chosen { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.brand) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(SettingsRowPressStyle())
                .accessibilityAddTraits(base == chosen ? .isSelected : [])
            }
        }
    }

    private func sub(_ base: String, first: Bool) -> String? {
        if Servers.isLocal(base) { return L("Dev stub on this Mac, from the simulator") }
        return first ? L("Default") : nil
    }

    /// A new server: whatever was on screen belonged to the old one. The
    /// token is kept per server, so the app reads afresh who it is there.
    private func restart() {
        SettingsModel.shared.reset()
        if let token = TokenStore.read() {
            app.signedIn(token: token, anonymous: Shared.defaults.bool(forKey: "anonymous"), email: nil)
        } else {
            app.clearLocal()
        }
    }
}

/// Settings › About › Licences: what terminus is built with, and the notices
/// their licences ask to be shown.
struct SettingsLicencesPane: View {
    var body: some View {
        ForEach(Self.entries, id: \.name) { e in
            SettingsGroup(title: e.name) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: e.licence).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink)
                    Text(verbatim: e.notice).font(.footnote).foregroundStyle(Color.muted).textSelection(.enabled).fixedSize(
                        horizontal: false, vertical: true)
                }
                .padding(16)
                GroupDivider()
                SettingLink(title: L("Licence in full"), sub: e.url.replacingOccurrences(of: "https://", with: ""), away: true) {
                    openInSafari(e.url)
                }
            }
        }
    }

    struct Entry {
        let name: String
        let licence: String
        let notice: String
        let url: String
    }

    /// The BSD licences' conditions and disclaimer, the same words in each.
    private static let bsdTerms = """
        Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

        * Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
        * Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
        """

    private static let bsdDisclaimer = """
        THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
        """

    static let entries: [Entry] = [
        Entry(
            name: "MapLibre Native",
            licence: "BSD 2-Clause License",
            notice:
                "Copyright (c) 2021 MapLibre contributors\nCopyright (c) 2018-2021 MapTiler.com\nCopyright (c) 2014-2020 Mapbox\n\n\(bsdTerms)\n\n\(bsdDisclaimer)",
            url: "https://github.com/maplibre/maplibre-native/blob/main/LICENSE.md"
        ),
        Entry(
            name: "Protomaps Basemaps",
            licence: "BSD 3-Clause License",
            notice:
                "Copyright 2019-2023 Protomaps LLC, Kelso Cartography\n\n\(bsdTerms)\n* Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.\n\n\(bsdDisclaimer)",
            url: "https://github.com/protomaps/basemaps/blob/main/LICENSE.md"
        ),
        Entry(
            name: "OpenStreetMap",
            licence: "Open Data Commons Open Database License (ODbL)",
            notice: "Map data, walking paths and route lines © OpenStreetMap contributors.",
            url: "https://www.openstreetmap.org/copyright"
        ),
        Entry(
            name: "Noto Sans",
            licence: "SIL Open Font License 1.1",
            notice:
                "The map's lettering, Chinese included. Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. Copyright 2022 The Noto Project Authors.",
            url: "https://openfontlicense.org"
        ),
    ]
}
