import SwiftUI

/// Settings › Favourites: your favourites in one card, each with Remove (and
/// Undo at the foot), ending in "Add a favourite", where the stops your
/// classes go to come first. As on Android.
struct SettingsFavouritesPane: View {
    let model: SettingsModel
    @State private var adding = false
    @State private var note: String?

    var body: some View {
        if let p = model.profile {
            SettingsGroup(
                title: L("Your favourites"),
                hint: note ?? L("Available in one tap from Now and the widgets. To go somewhere every week, add it to your timetable.")
            ) {
                ForEach(p.places) { place in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(place.label).foregroundStyle(Color.ink)
                            // Where it goes, when the name doesn't already say.
                            if let campus = model.campus, place.label != settingsStopName(campus, place.to) {
                                SettingsHint(L("%@ stop", settingsStopName(campus, place.to)))
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        QuietRemove(says: L("Remove %@", place.label)) {
                            withAnimation { model.removePlace(place.key) }
                        }
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 8)
                    .padding(.vertical, 6)
                    .transition(.opacity.combined(with: .move(edge: .leading)))
                    GroupDivider()
                }
                if p.places.count < p.limits.places {
                    SettingsAddRow(title: L("Add a favourite"), id: "settings.addFavourite") {
                        note = nil
                        adding = true
                        Task { await model.loadCampus() }
                    }
                } else {
                    SettingsHint(L("That's the most favourites you can have. Remove one to add another.")).padding(16)
                }
            }
            .sheet(isPresented: $adding) {
                SettingsWherePicker(title: L("Add a favourite"), destinations: model.campus?.destinations ?? [], pinned: timetableStops(p))
                { add($0, p) }
            }
        } else {
            SettingsProfileLoading()
        }
    }

    /// The stops your classes go to that aren't favourites yet, each saying which classes use it.
    private func timetableStops(_ p: ProfileDoc) -> [WhereItem] {
        let favourite = Set(p.places.map(\.to))
        let classes = Dictionary(grouping: p.trips + p.manual, by: \.to).filter { !favourite.contains($0.key) }
        return classes.map { to, list in
            let names = list.map { $0.label.components(separatedBy: " @ ").first ?? $0.label }
            var seen = Set<String>()
            let label = model.campus.map { settingsStopName($0, to) } ?? to
            return WhereItem(
                code: to, label: label, kind: "timetable",
                detail: names.filter { seen.insert($0).inserted }.joined(separator: settingsListSep), goesTo: to)
        }
        .sorted { $0.label.localizedStandardCompare($1.label) == .orderedAscending }
    }

    /// No name to type: it's called what was picked, short, as it reads on a button.
    private func add(_ d: WhereItem, _ p: ProfileDoc) {
        if let same = p.places.first(where: { $0.to == d.goesTo }) {
            note = L("Already a favourite: %@", same.label)
            announce(note)
            return
        }
        let name = d.kind == "building" || d.kind == "room" ? d.code : d.label
        withAnimation { model.edit { $0.addPlace(label: name, to: d.goesTo) } }
    }
}
