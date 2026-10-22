# Putting terminus on your iPhone yourself

terminus isn't on the App Store yet. Until it is, you can install it on your
own iPhone with a free Apple ID. Any Apple ID works; you don't need to pay
Apple anything.

**What's different from the App Store version.** A free Apple ID can't use
push notifications, so:

- The Live Activity starts only when you open terminus, not by itself
  when it's time to go, and only updates while the app is open or
  refreshing in the background, not the moment your bus changes.
- Leave reminders still come (the app sets them itself), but one won't
  move if your bus changes while the app is closed.
- Reminders can't break through a Focus, as Time Sensitive ones would.
- Pairing links (`/pair`) don't open the app. Type the pairing code, or
  scan its QR code from the app.
- A Live Activity doesn't end by itself right after you arrive; it goes
  when you next open terminus, or within an hour.

Now, Buses, the map, the widgets and Settings work as usual.

**It needs renewing every 7 days.** Apps signed with a free Apple ID stop
opening after 7 days. Renewing (below) keeps your account and settings.

There are two ways to install it. Pick one.

## With a Mac (Xcode)

You need a Mac with [Xcode](https://apps.apple.com/app/xcode/id497799835),
[Homebrew](https://brew.sh) and a cable for your iPhone.

1. Open Xcode once, then **Xcode › Settings › Accounts › +** and sign in
   with your Apple ID.
2. In Terminal:

   ```sh
   brew install xcodegen
   git clone https://github.com/rcnsh/terminus.git
   cd terminus/apps/ios
   ```

   Until the iPhone app is released, it lives on the `ios` branch, not
   `main`. If `apps/ios` isn't there, ask for that branch, or for an
   `.ipa` (below).

3. Plug in the iPhone, unlock it and tap **Trust**.
4. Run:

   ```sh
   scripts/sideload.sh
   ```

   It builds terminus, signs it with your Apple ID and installs it.

5. The first time, on the iPhone:
   - **Settings › Privacy & Security › Developer Mode**: turn it on. The
     iPhone restarts.
   - **Settings › General › VPN & Device Management**: tap your Apple ID,
     then **Trust**.

**To renew:** plug the iPhone in and run `scripts/sideload.sh` again within
the 7 days.

## Without a Mac (AltStore, SideStore or Sideloadly)

These sign the app with your Apple ID on your own computer.
[AltStore](https://altstore.io) and [SideStore](https://sidestore.io) also
renew it for you in the background.

1. Get `terminus-<version>.ipa` from whoever shared it with you, or make it
   on a Mac with `scripts/sideload.sh --ipa` (it lands in
   `apps/ios/build/sideload/`).
2. Set up AltStore, SideStore or Sideloadly by its own guide.
3. Open the `.ipa` in it and sign in with your Apple ID when it asks.
4. Do step 5 above, if the iPhone asks.

The widgets work this way too: open terminus once after installing, and
they show what it last saw.

## Limits of a free Apple ID

- At most 3 sideloaded apps on one iPhone at a time.
- At most 10 new apps a week per Apple ID.
- It only installs on iPhones you have plugged in (or that AltStore runs on).

Only download a terminus `.ipa` from someone you trust. Anyone can build
one, and it signs in to your terminus account.
