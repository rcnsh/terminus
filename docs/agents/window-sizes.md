# Window sizes

How the iPhone, Android and web clients lay out at each window width:
phones, iPads, Android tablets and foldables, an unfolded iPhone Duo,
Split View and Stage Manager windows, and a browser on a laptop. The
Mac's menu bar popover is phone-sized and stays as it is. Why it's done
this way: [ADR 0015](../adr/0015-window-sizes.md).

## The three widths

The window's width decides, in points, dp or CSS pixels, read live:
a fold, a rotation, a resized window or Split View changes it mid-session.
The device, its idiom (`userInterfaceIdiom`, `isTablet`), the screen's
size and the orientation never decide a layout.

Which way the window may turn is a separate question. An iPhone turns on
its side only where the screen's shorter side is 600 or more, as on an open
iPhone Duo (`WindowWidth.phoneTurns`): an ordinary iPhone on its side is
about 400 tall, and the card's sky leaves no room for its steps or for
Today. iPads, Android and the web turn freely.

| Width | Name | Layout |
| --- | --- | --- |
| under 600 | narrow | The phone layout. |
| 600 to 799 | medium | The phone layout in a centred column at most 560 wide (gutters included), the sky still edge to edge. |
| 800 and over | wide | Two panes on Now, Stops and Settings, as below. |

Height never changes the layout. A phone on its side that's 800 wide
is wide.

## Wide, tab by tab

- **Tabs.** Each platform's own navigation for a large screen. iPhone
  app: the system's (iPad's tab bar at the top or its sidebar, the
  Duo's side rail), from `TabView` as it is. Android: a
  `NavigationRail` on the leading edge from 600, Material's own
  threshold, with the same four items and icons as the bar. Web: a rail
  on the left edge from 800, icons over labels, in place of the bottom
  bar.
- **Now.** The sky runs the window's width. Its words (the wordmark,
  notices, chips, search, the head with "Leave in …") sit in a column
  at most 1040 wide, centred. Under the horizon, in that same column:
  the card's steps and buttons in the left half, Today in the right
  half, the footer under Today. Today shows whichever chip is chosen
  (it's your day either way), whenever the client has a day to show.
  With no day, the card is alone, centred, at most 560 wide. The
  horizon's bus, stop sign and town stay drawn across the full width.
  With no day, all of Now's words (wordmark, notices, chips, head) move
  into that 560 column too, so they line up with the card. The search
  ("Elsewhere") sits at the trailing end of the chips' row at every
  width.
- **Stops.** List and detail. The home (search, pinned stops,
  services) in a pane 360 wide on the leading side; the page opened
  from it (a stop, a line, and the pages opened from those) fills the
  rest, its content in the 560 column, with Back inside that pane when
  one page was opened from another. A hairline divides the panes; each
  keeps its own sky band at the top, so the sky reads across the
  window. Nothing open: the detail pane says "Choose a stop or a
  service." in the muted colour, centred. A stop or line opened from
  another tab (Now, Nearby, the map's list) opens in the detail pane.
  The row for the open stop or line, or the open pinned stop's card, is
  marked as chosen in the list. Search results replace the list in the
  home pane, as rows of the same kind the phone shows.
- **Map.** The map fills the window. From 700 wide (medium too) a stop's
  or bus's sheet floats in the bottom-left corner, 360 wide, all
  corners rounded, no taller than the room under the pills; the camera,
  the map's buttons and its credit allow for it. Narrower, the sheet
  lies across the bottom.
- **Settings.** List and detail, as Stops: the list of pages in a
  pane 360 wide, the open page beside it in the 560 column. "Your
  trips" is open until another is picked, so the detail pane is never
  empty (not the account: a first look shouldn't land on Sign out); the
  open page's row is marked as chosen. In the list pane a row's value
  sits on a line under its name, so nothing is cut off. A page opened
  from a page pushes inside the detail pane.
- **Sheets and dialogs** (report a problem, sign in, go later, the
  pickers): the platform's centred sheet or dialog, at most 560 wide,
  from 600.
- **Welcome, setup, pairing and sign-in:** the 560 column at every
  width.

- **Chosen.** A chosen row or card in a list pane has a fill of the
  accent at low opacity (the brand colour, about 12%), with rounded
  corners, and nothing else (no bar or outline), and says it's selected
  to a screen reader.
- **The sky across panes.** Side by side, the panes' sky bands end at
  the same height, so their horizons meet, and only the trailing pane
  draws the moon and stars.

Text, controls, cards and touch targets keep their phone sizes at
every width. The extra room is for showing more beside, never for
making things bigger.

## Checking a layout

A change to any screen is checked at narrow, medium and wide before
it's done, in light and dark, with the dev stub
([dev-stub.md](dev-stub.md)), from screenshots:

| Client | Narrow | Medium | Wide |
| --- | --- | --- | --- |
| iPhone | iPhone 17 or 18 Pro | iPad in a Split View half, or iPad mini portrait (744) | iPad Pro 11-inch landscape (1210); iPhone Duo open (867) |
| Android | Pixel phone | Pixel Fold or a foldable AVD open, or a tablet in split screen | Pixel Tablet landscape (1280) and portrait (800) |
| Web | `shot.mjs --width 390` | `--width 700` | `--width 1280` |

iPads run on the iOS 27.0 simulator runtime; the iPhone Duo needs
27.1. The Duo's simulator folds with T3's `agent-device fold`.
