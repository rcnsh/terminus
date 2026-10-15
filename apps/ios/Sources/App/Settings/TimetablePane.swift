import SwiftUI

/// Settings › Timetable: import from NUSMods, then every class by day and
/// time (tap one to change its stop), "Add a class or commitment by hand",
/// and favourites at their usual time each week. As on Android.
struct SettingsTimetablePane: View {
    let model: SettingsModel
    @State private var link = ""
    @State private var changing: ClassEntry?
    @State private var placing: UnplacedPick?
    @State private var adding = false

    var body: some View {
        if let p = model.profile {
            VStack(alignment: .leading, spacing: 22) {
                if model.me?.needsReimport == true { reimport }
                importGroup(p)
                classesGroup(p)
                usualGroup(p)
            }
            .onAppear { if link.isEmpty { link = model.sharedLink ?? p.share ?? "" } }
            .onChange(of: model.sharedLink) { _, l in if let l { link = l } }
            .sheet(item: $changing) { c in
                SettingsWherePicker(title: L("Stop for %@", c.trip.label), destinations: model.campus?.destinations ?? []) { d in
                    model.edit { $0.setClassStop(c, to: d.goesTo) }
                }
            }
            .sheet(item: $placing) { pick in
                SettingsWherePicker(title: L("Stop for %@", pick.u.module), destinations: model.campus?.destinations ?? []) { d in
                    model.place(pick.u, to: d.goesTo)
                }
            }
            .sheet(isPresented: $adding) { AddClassSheet(model: model) }
        } else {
            SettingsProfileLoading()
        }
    }

    /// The semester the link is for has ended: said above everything else.
    private var reimport: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L("Re-import your timetable.")).font(.headline).foregroundStyle(Color.ink)
            Text(
                L("This link is for %@, which has ended. Copy this semester's link from NUSMods and import it below.", model.me?.term ?? "")
            )
            .font(.subheadline)
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.brandSoft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private func importGroup(_ p: ProfileDoc) -> some View {
        SettingsGroup(
            title: L("From NUSMods"),
            hint: L("In NUSMods: Timetable, then Share/Sync. Copy the link and paste it here. Re-import each semester.")
        ) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    TextField(L("NUSMods share link"), text: $link, prompt: Text(verbatim: "https://nusmods.com/timetable/sem-1/share?…"))
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit { model.importTimetable(link) }
                        // NUSMods shares a sentence with the link in it: just the link is kept.
                        .onChange(of: link) { _, v in if let l = settingsNusmodsLink(in: v), l != v { link = l } }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(Color.surface2, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .accessibilityLabel(L("NUSMods share link"))
                        .accessibilityIdentifier("settings.nusmodsLink")
                    Button(model.importing ? L("Importing…") : L("Import")) { model.importTimetable(link) }
                        .buttonStyle(SettingsInkButtonStyle())
                        .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.importing)
                        .accessibilityIdentifier("settings.import")
                }
                if let r = model.imported {
                    Text(r.summary).foregroundStyle(Color.ink).announced(r.summary)
                    if let m = r.missingText { SettingsHint(m) }
                } else if !p.trips.isEmpty {
                    SettingsHint(p.trips.count == 1 ? L("1 class imported.") : L("%@ classes imported.", "\(p.trips.count)"))
                }
                unplacedList
            }
            .padding(16)
        }
    }

    /// Classes whose room couldn't be placed: a stop for each, or Skip.
    @ViewBuilder private var unplacedList: some View {
        let list = model.unplaced
        if !list.isEmpty {
            Text(
                list.count == 1
                    ? L("1 class had a venue we couldn't place. Pick the nearest stop, or skip it:")
                    : L("%@ classes had a venue we couldn't place. Pick the nearest stop, or skip it:", "\(list.count)")
            )
            .font(.subheadline)
            .foregroundStyle(Color.bad)
            .fixedSize(horizontal: false, vertical: true)
            ForEach(list, id: \.self) { u in
                VStack(alignment: .leading, spacing: 6) {
                    Text(
                        "\(SettingsTime.dayShort(u.day)) \(SettingsTime.clock(u.arriveByMin)) · \(u.module) @ \(u.venue)\(u.offCampus ? L(" (off campus)") : "")"
                    )
                    .foregroundStyle(Color.ink)
                    HStack(spacing: 8) {
                        Button(L("Choose a stop")) { placing = UnplacedPick(u: u) }
                            .buttonStyle(ChipButtonStyle())
                        Button(L("Skip")) { model.skip(u) }
                            .buttonStyle(ChipButtonStyle())
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private func classesGroup(_ p: ProfileDoc) -> some View {
        let all = p.classes
        return SettingsGroup(title: settingsClassCount(all.count), hint: all.isEmpty ? nil : L("Tap a class to change its stop.")) {
            ForEach(all) { c in
                HStack(spacing: 4) {
                    Button {
                        changing = c
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(SettingsTime.dayShort(c.trip.day)) \(SettingsTime.clock(c.trip.arriveByMin)) · \(c.trip.label)")
                                .foregroundStyle(Color.ink)
                            let about = [
                                model.campus.map { L("%@ stop", settingsStopName($0, c.trip.to)) }, c.imported ? nil : L("added by hand"),
                            ].compactMap { $0 }
                            if !about.isEmpty { SettingsHint(about.joined(separator: " · ")) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(L("Change the stop for %@", c.trip.label))
                    QuietRemove(says: L("Remove %@", c.trip.label)) {
                        withAnimation { model.edit { $0.removeClass(c) } }
                    }
                }
                .padding(.leading, 16)
                .padding(.trailing, 8)
                GroupDivider()
            }
            SettingsAddRow(title: L("Add a class or commitment by hand"), id: "settings.addClass") {
                adding = true
                Task { await model.loadCampus() }
            }
        }
    }

    /// A favourite at its usual time each week: removable here with the classes.
    @ViewBuilder private func usualGroup(_ p: ProfileDoc) -> some View {
        let usual = p.usual.compactMap { u in p.places.first { $0.key == u.place }.map { (u, $0) } }
            .sorted { a, b in
                let da = mondayFirst.firstIndex(of: a.0.day) ?? 7
                let db = mondayFirst.firstIndex(of: b.0.day) ?? 7
                return da != db ? da < db : a.0.atMin < b.0.atMin
            }
        if !usual.isEmpty {
            SettingsGroup(title: L("Every week")) {
                ForEach(Array(usual.enumerated()), id: \.element.0) { i, pair in
                    let (u, place) = pair
                    if i > 0 { GroupDivider() }
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(SettingsTime.dayShort(u.day)) \(SettingsTime.clock(u.atMin)) · \(place.label)").foregroundStyle(
                                Color.ink)
                            if let campus = model.campus { SettingsHint(L("%@ stop", settingsStopName(campus, place.to))) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        QuietRemove(says: L("Remove %@", place.label)) { model.edit { $0.removeUsual(u) } }
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 8)
                    .padding(.vertical, 6)
                }
            }
        }
    }
}

/// An unplaced class, while its stop is being picked.
private struct UnplacedPick: Identifiable {
    let u: Unplaced
    var id: Unplaced { u }
}

/// A stop's name, or a food court's (favourites and classes can go to one).
func settingsStopName(_ campus: Campus, _ code: String) -> String {
    campus.stops.first { $0.code == code }?.name ?? campus.destinations.first { $0.code == code && $0.kind == "landmark" }?.label ?? code
}

/// The NUSMods link in text that has more round it (NUSMods shares a sentence with the link in it).
func settingsNusmodsLink(in text: String) -> String? {
    guard let r = text.range(of: #"https?://(?:www\.)?nusmods\.com/timetable/\S+"#, options: .regularExpression) else { return nil }
    return String(text[r]).trimmingCharacters(in: CharacterSet(charactersIn: ".,)"))
}

/// A class or commitment by hand: its day, times, name and where.
private struct AddClassSheet: View {
    let model: SettingsModel
    @State private var day = 1
    @State private var start = SettingsTime.date(9 * 60)
    @State private var hasEnd = false
    @State private var end = SettingsTime.date(10 * 60)
    @State private var name = ""
    @State private var picked: WhereItem?
    @State private var picking = false
    @Environment(\.dismiss) private var dismiss

    private var startMin: Int { SettingsTime.minutes(start) }
    private var endMin: Int { SettingsTime.minutes(end) }
    private var canAdd: Bool {
        picked != nil && !name.trimmingCharacters(in: .whitespaces).isEmpty && (!hasEnd || endMin > startMin)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker(L("Day"), selection: $day) {
                        ForEach(mondayFirst, id: \.self) { Text(SettingsTime.dayLong($0)).tag($0) }
                    }
                    DatePicker(L("Starts"), selection: $start, displayedComponents: .hourAndMinute)
                    Toggle(L("Ends"), isOn: $hasEnd.animation()).tint(.brand)
                    if hasEnd {
                        DatePicker(L("Ends at"), selection: $end, displayedComponents: .hourAndMinute)
                        if endMin <= startMin { Text(L("It has to end after it starts.")).font(.footnote).foregroundStyle(Color.bad) }
                    }
                }
                .environment(\.timeZone, TimeZone(identifier: "UTC")!)
                .environment(\.locale, SettingsTime.pickerLocale)
                .listRowBackground(Color.surface)
                Section {
                    TextField(L("Name, e.g. Gym"), text: $name)
                        .onChange(of: name) { _, v in
                            let max = model.profile?.limits.label ?? 60
                            if v.count > max { name = String(v.prefix(max)) }
                        }
                        .accessibilityIdentifier("settings.className")
                    Button {
                        picking = true
                    } label: {
                        HStack {
                            Text(L("Where")).foregroundStyle(Color.ink)
                            Spacer()
                            Text(picked?.label ?? L("Stop, building or room")).foregroundStyle(picked == nil ? Color.faint : Color.brand)
                            Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
                        }
                    }
                    .accessibilityIdentifier("settings.classWhere")
                }
                .listRowBackground(Color.surface)
            }
            .scrollContentBackground(.hidden)
            .background(Color.page)
            .navigationTitle(L("Add a class or commitment"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Add")) {
                        guard let d = picked else { return }
                        let s = startMin
                        let e = endMin
                        model.edit {
                            $0.addManual(
                                ProfileTrip(
                                    day: day, arriveByMin: s, endMin: hasEnd && e > s ? e : nil, to: d.goesTo,
                                    label: name.trimmingCharacters(in: .whitespaces), venue: ""))
                        }
                        dismiss()
                    }
                    .disabled(!canAdd)
                    .accessibilityIdentifier("settings.addClassDone")
                }
            }
            .sheet(isPresented: $picking) {
                SettingsWherePicker(title: L("Where"), destinations: model.campus?.destinations ?? []) { picked = $0 }
            }
        }
    }
}
