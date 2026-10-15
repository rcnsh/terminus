import SwiftUI

/// Your timetable: a NUSMods share link, imported, and the week it makes.
struct SetupClassesStep: View {
    @Bindable var model: OnboardingModel

    var body: some View {
        let classes = model.classes
        let pending = model.linkPending
        SetupPage(
            title: L("Your timetable"), sub: L("Paste your NUSMods share link. Each class goes to the stop nearest its room."),
            message: model.message
        ) {
            // As on the home step: Continue means there's a timetable; with none, it's the skip.
            SetupButtons(
                back: model.back,
                skip: classes.isEmpty && !pending ? L("I'll do this later") : nil,
                enabled: !model.importing,
                busy: model.importing && pending
            ) {
                // Continue imports a link that was pasted but not imported yet, then moves on once it has.
                if pending {
                    Task { if await model.importTimetable() { model.next() } }
                } else {
                    model.next()
                }
            }
        } content: {
            SetupTimetableImport(model: model)
            SetupWeek(classes: classes, campus: model.campus)
        }
    }
}

/// The link, Import, and what came of it.
private struct SetupTimetableImport: View {
    @Bindable var model: OnboardingModel
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("NUSMods share link")).font(.caption.weight(.medium)).foregroundStyle(focused ? Color.brand : Color.muted)
                    TextField(
                        L("NUSMods share link"), text: $model.link, prompt: Text(verbatim: "https://nusmods.com/timetable/sem-1/share?…")
                    )
                    .font(.body)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.go)
                    .focused($focused)
                    .onSubmit { Task { await model.importTimetable() } }
                    .accessibilityIdentifier("classes.link")
                }
                if model.link.isEmpty {
                    PasteButton(payloadType: String.self) { strings in
                        if let s = strings.first { model.link = Self.nusmodsLink(in: s) ?? s }
                    }
                    .labelStyle(.titleOnly)
                    .buttonBorderShape(.capsule)
                    .tint(.brand)
                    .accessibilityIdentifier("classes.paste")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(
                    focused ? Color.brand : Color.line, lineWidth: focused ? 2 : 1))
            SetupHint(L("In NUSMods: Timetable, then Share/Sync. Copy the link and paste it here."))
            Button(model.importing ? L("Importing…") : L("Import")) {
                focused = false
                Task { await model.importTimetable() }
            }
            .buttonStyle(ChipButtonStyle(filled: true))
            .disabled(model.link.trimmingCharacters(in: .whitespaces).isEmpty || model.importing)
            .padding(.top, 2)
            .accessibilityIdentifier("classes.import")

            if let r = model.imported {
                Text(r.summary)
                    .font(.body)
                    .foregroundStyle(Color.ink)
                    .padding(.top, 6)
                    .announced(r.summary)
                    .accessibilityIdentifier("classes.summary")
                SetupUnplaced(model: model)
                if let m = r.missingText { SetupHint(m) }
            } else if model.importedClasses > 0 {
                SetupHint(model.importedClasses == 1 ? L("1 class imported.") : L("%@ classes imported.", "\(model.importedClasses)"))
                    .padding(.top, 6)
            }
        }
    }

    /// NUSMods shares a sentence with the link in it: the link.
    static func nusmodsLink(in text: String) -> String? {
        guard let r = text.range(of: #"https?://(www\.)?nusmods\.com/timetable/\S+"#, options: .regularExpression) else { return nil }
        return String(text[r]).trimmingCharacters(in: CharacterSet(charactersIn: ".,)"))
    }
}

/// Imported classes whose room couldn't be placed: pick a stop for each, or skip it.
private struct SetupUnplaced: View {
    let model: OnboardingModel

    var body: some View {
        let list = model.unplaced
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text(
                    list.count == 1
                        ? L("1 class had a venue we couldn't place. Pick the nearest stop, or skip it:")
                        : L("%@ classes had a venue we couldn't place. Pick the nearest stop, or skip it:", "\(list.count)")
                )
                .font(.subheadline)
                .foregroundStyle(Color.bad)
                .fixedSize(horizontal: false, vertical: true)
                ForEach(list, id: \.self) { u in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(
                                verbatim: "\(setupDay(u.day)) \(setupClock(u.arriveByMin)) · \(u.module) @ \(u.venue)"
                                    + (u.offCampus ? L(" (off campus)") : "")
                            )
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.ink)
                            .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 8)
                            Button(L("Skip")) { withAnimation { model.skip(u) } }
                                .font(.subheadline.weight(.semibold))
                                .accessibilityIdentifier("classes.skip.\(u.module).\(u.day)")
                        }
                        SetupWherePicker(destinations: model.campus?.destinations ?? []) { d in
                            withAnimation { model.place(u, to: d.goesTo) }
                        }
                    }
                    .cardStyle(padding: 12, radius: 14)
                }
            }
            .padding(.top, 4)
        }
    }
}

/// "Stop, building or room": the same search as Now's, the pick handed on.
private struct SetupWherePicker: View {
    let destinations: [Destination]
    let pick: (Destination) -> Void
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.muted)
                TextField(L("Choose a stop"), text: $query, prompt: Text(L("Stop, building or room")))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityLabel(L("Choose a stop"))
            }
            .padding(10)
            .background(Color.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            let found = rankDestinations(destinations, query, max: 6)
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                if found.isEmpty && !destinations.isEmpty {
                    SetupHint(L("No stop, building or room by that name")).padding(.vertical, 8)
                }
                ForEach(found, id: \.code) { d in
                    Button {
                        query = ""
                        pick(d)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.label).font(.body).foregroundStyle(Color.ink)
                            Text(Self.kind(d)).font(.footnote).foregroundStyle(Color.muted)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
        }
    }

    static func kind(_ d: Destination) -> String {
        switch d.kind {
        case "stop": L("Bus stop")
        case "landmark": d.detail ?? L("Place")
        case "building": L("Building")
        default: L("Room %@", d.code)
        }
    }
}

/// The week as imported: each day's classes in order, each beside the stop
/// terminus will take you to, so a wrong one is easy to spot before going on.
private struct SetupWeek: View {
    let classes: [OnboardingModel.Class]
    let campus: Campus?

    var body: some View {
        if !classes.isEmpty {
            // Monday first, as a timetable is read.
            let sorted = classes.sorted { a, b in
                let da = (a.day + 6) % 7
                let db = (b.day + 6) % 7
                return da != db ? da < db : a.arriveByMin < b.arriveByMin
            }
            let days = sorted.reduce(into: [(Int, [OnboardingModel.Class])]()) { out, c in
                if out.last?.0 == c.day { out[out.count - 1].1.append(c) } else { out.append((c.day, [c])) }
            }
            VStack(alignment: .leading, spacing: 0) {
                ForEach(days, id: \.0) { day, list in
                    Divider()
                    HStack(alignment: .top, spacing: 0) {
                        Text(setupDay(day))
                            .font(.subheadline.weight(.bold))
                            .foregroundStyle(Color.muted)
                            .frame(width: 52, alignment: .leading)
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(list) { c in
                                HStack(spacing: 8) {
                                    Text(setupClock(c.arriveByMin))
                                        .font(.footnote)
                                        .monospacedDigit()
                                        .foregroundStyle(Color.muted)
                                        .frame(width: 64, alignment: .leading)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(c.label).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).lineLimit(1)
                                        // The room, unless the name already says it ("MA1521 @ LT27").
                                        if !c.venue.isEmpty && !c.label.contains(c.venue) {
                                            Text(c.venue).font(.footnote).foregroundStyle(Color.muted).lineLimit(1)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    SetupStopChip(name: campus?.stopName(c.to) ?? c.to)
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    .padding(.vertical, 10)
                }
            }
            .padding(.top, 18)
            .accessibilityIdentifier("classes.week")
        }
    }
}

/// A stop's name on a little plate, as on its sign.
private struct SetupStopChip: View {
    let name: String
    var body: some View {
        Text(name)
            .font(.caption.weight(.bold))
            .foregroundStyle(Color.page)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Color.ink, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }
}
