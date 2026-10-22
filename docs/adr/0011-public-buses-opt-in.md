# Public buses are opt-in, kept in their own graph, and must beat the shuttle by the fare

Public buses (95, 151, …) cost money and run on LTA's data, while terminus is about the free shuttle. So they are off until the user turns them on, and they live in a second graph so the map, search and golden answers built from the shuttle graph never see them (8b00e9ca). A public bus is the headline only when it beats the shuttle by `PUBLIC.fareWorthS`. LTA's unmonitored times count as timetabled, never live.
