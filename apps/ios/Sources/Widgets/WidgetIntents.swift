import AppIntents
import WidgetKit

// The intents' titles are looked up by the system in the phone's language,
// from the extension's Widgets.strings (keyed by the English, as L's are),
// not through L, which follows the app's own choice.

/// ↻ on a widget: the plan (or the place it shows) asked for again now.
struct RefreshIntent: AppIntent {
    static let title = LocalizedStringResource("Refresh", table: "Widgets")
    static let isDiscoverable = false

    @Parameter(title: "Slot") var slot: String?

    init() {}
    init(slot: String?) { self.slot = slot }

    func perform() async throws -> some IntentResult {
        if let slot, WidgetStore.slot(slot).chosen != .timetable {
            await WidgetStore.fetch(slot: slot)
        } else {
            // Shows the tap landed while the answer is on its way.
            WidgetStore.error = WidgetFace.updating
            WidgetCenter.shared.reloadAllTimelines()
            if await WidgetStore.refreshPlan(force: true) == nil, WidgetStore.error == WidgetFace.updating { WidgetStore.error = nil }
        }
        return .result()
    }
}

/// A button along the widget: Timetable, Nearby or one of your places, shown in place without opening the app.
struct ModeIntent: AppIntent {
    static let title = LocalizedStringResource("Show", table: "Widgets")
    static let isDiscoverable = false

    @Parameter(title: "Slot") var slot: String
    @Parameter(title: "Mode") var mode: String
    @Parameter(title: "Label") var label: String?

    init() {}
    init(slot: String, mode: WidgetMode) {
        self.slot = slot
        self.mode = mode.id
        self.label = mode == .timetable ? nil : mode.label
    }

    func perform() async throws -> some IntentResult {
        await WidgetStore.choose(WidgetMode.of(id: mode, label: label), slot: slot)
        return .result()
    }
}

/// The swap button on Nearby: the stop across the road first, or the nearest again.
struct SwapIntent: AppIntent {
    static let title = LocalizedStringResource("Other side of the road", table: "Widgets")
    static let isDiscoverable = false

    @Parameter(title: "Slot") var slot: String
    @Parameter(title: "From") var from: String
    @Parameter(title: "To") var to: String

    init() {}
    init(slot: String, from: String, to: String) {
        self.slot = slot
        self.from = from
        self.to = to
    }

    func perform() async throws -> some IntentResult {
        WidgetStore.swap(from: from, to: to, slot: slot)
        return .result()
    }
}
