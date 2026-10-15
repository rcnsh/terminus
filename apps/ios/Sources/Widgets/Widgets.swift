import SwiftUI
import WidgetKit

/// The widgets, as Android's two: "Next bus" (also on the Lock Screen) and
/// "Next bus + favourites" with buttons for Nearby and your places; and the
/// Live Activity for a trip under way.
@main
struct TerminusWidgets: WidgetBundle {
    var body: some Widget {
        NextBusWidget()
        PlacesWidget()
        TripLiveActivity()
    }
}

struct NextBusWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "next", provider: BusProvider(kind: "next")) { entry in
            BusWidgetView(entry: entry, kind: "next")
        }
        .configurationDisplayName(L("Next bus"))
        .description(L("The next bus to wherever you're going next"))
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryRectangular, .accessoryCircular, .accessoryInline])
        .contentMarginsDisabled()
    }
}

struct PlacesWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "places", provider: BusProvider(kind: "places")) { entry in
            BusWidgetView(entry: entry, kind: "places")
        }
        .configurationDisplayName(L("Next bus + favourites"))
        .description(L("The next bus, plus buttons for your favourites and nearby departures"))
        .supportedFamilies([.systemMedium, .systemLarge])
        .contentMarginsDisabled()
    }
}
