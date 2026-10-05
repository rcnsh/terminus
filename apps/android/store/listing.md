# Google Play listing

What goes into Play Console. The images are in this folder. Redraw the icon
and feature graphic with `swift apps/android/store/render.swift apps/android/store`.
The phone screenshots are in `screenshots/`: 1080×1920, taken on the emulator
against `apps/api/scripts/dev-stub.mjs` (fake buses and a test account, no real data).

## App name (30 characters max)

NUS is left out of the name, so it doesn't look like an official NUS app. The descriptions say it's for NUS and that it isn't affiliated.

```
terminus: campus bus planner
```

## Short description (80 characters max)

```
When to leave for class, and which campus bus to catch, from your timetable.
```

## Full description (4000 characters max)

```
terminus tells you when to leave for your next class, and which campus bus to catch to get there on time.

Import your NUSMods timetable once. From then on, terminus plans the whole trip: the walk to the stop, the bus's live arrival, the ride, and the walk to your classroom. Instead of a list of arrival times, you get one answer: "Leave by 9:01 · catch the 9:06 R2 at PGP · arrive 9:16, 14 min early".

ONE ANSWER, ON YOUR HOME SCREEN
• The widget shows when to leave for your next class. Its buttons switch it to the buses near you, or the quickest way to your favourite places, without opening the app.
• The whole trip at a glance: you, the stop and your class on one line, with the bus in its colour and when you'll get there. Prefer it as a ticket or a list of steps? Choose in Settings › Appearance.
• A heads-up five minutes before you need to set off.
• Late? It says so, and offers the quickest way there.
• If the bus you'd catch is often busy at that stop and time, it aims for one bus earlier.

IT FOLLOWS YOUR TRIP
• Once your bus leaves, terminus takes it you're on it and shows the next stop and when you'll get there.
• Turn on "Notice when I board" and, during a trip, it uses your location to tell when you're on the bus, when you've missed it, and when you're there. On the bus, your arrival comes from that bus's live position.
• Missed it? The next way there, straight away.
• Not going? Swipe it off today's list, on every device.

ANYWHERE ON CAMPUS
• Search any building, stop or room. The last five places you look up keep a tab of their own, and the newest one gets a button on the widget.
• Favourites: pick a stop, building or room and it's saved. The stops your classes use come first.
• Nearby: every bus at the stops around you, live. Wrong side of the road? One tap, in the app or on the widget, shows the stop across it.
• The map: every route in its colour on a street map of campus. Pick a service to see its buses moving live; tap a stop for what's coming. Works offline after the first look.

IT LEARNS, AND ASKS FIRST
• Keep missing the bus to one class? It offers to leave one bus earlier for it.
• Skipping a class every week? It offers to stop reminders for it.
Nothing changes unless you say yes, and every choice can be undone.

ALSO
• Today: your classes, when to leave for each, and the trip home.
• In English and Simplified Chinese (简体中文).
• Works with the terminus menu bar app for Mac and the website, on iPhone too. Add an email and they all show the same trip.

PRIVATE BY DESIGN
• No sign-up: the app makes an account of its own. Adding an email is optional, and only needed to use terminus on another device.
• Your location is used to find the stops near you and show where you are on the map while you use the app or tap a widget button, and during a trip only if you turn on "Notice when I board". terminus keeps what it means (on the bus, missed it, there), never where you were.
• No ads, no tracking, no analytics SDK.
• Download everything terminus keeps about you from Settings. Delete your account and everything with it from Settings (with an email added, from the account page), or clear just your trip history.

terminus is an independent app. It is not made by, endorsed by or affiliated with the National University of Singapore. Bus times come from NUS's public shuttle feed.
```

## Simplified Chinese listing (zh-CN)

Add it in Play Console under Store presence → Main store listing → Manage translations → Add your own translation → Chinese (Simplified) – zh-CN. The Chinese screenshots are in `screenshots/zh/`. Like the app's Chinese, it awaits a native speaker's review.

App name:

```
terminus：校园巴士出行助手
```

Short description:

```
根据你的课表，告诉你什么时候出发上课、该搭哪一班校园巴士。
```

Full description:

```
terminus 告诉你什么时候该出发去上下一节课，以及该搭哪一班校园巴士才能准时到。

只要导入一次 NUSMods 课表，terminus 就会规划整段行程：走到车站、巴士的实时到站时间、乘车，以及走到教室。你看到的不是一串到站时间，而是一个答案：“9:01 前出发 · 在 PGP 搭 9:06 的 R2 · 9:16 到，早 14 分钟”。

一个答案，就在主屏幕上
• 小组件显示下一节课什么时候出发。点它上面的按钮，不用打开应用就能看附近的巴士，或去收藏地点最快的方式。
• 整段行程一眼看完：你、车站和课室连成一条线，巴士用它的颜色标出，还有几点到达。想看成车票或逐条步骤？在“设置 › 外观”里选。
• 需要出发前五分钟提醒你。
• 要迟到了？它会直说，并给出最快的走法。
• 如果你要搭的那班车在那个站、那个时间经常很挤，它会建议早一班。

它会跟着你的行程
• 巴士开走后，terminus 会当作你已经上车，并显示下一站和你什么时候到。
• 打开“上车时自动识别”后，行程中它会用你的位置判断你是否已经上车、错过了车，或已经到达。在车上时，到达时间来自那辆车的实时位置。
• 错过了？立刻给出下一种走法。
• 不去了？把它从今天的列表里滑掉，所有设备同步。

校园里哪里都能去
• 搜索任何建筑、车站或教室。你最近查过的五个地点会保留自己的标签；最新的一个会出现在小组件的按钮上。
• 收藏：选一个车站、建筑或教室就能保存。你上课用到的车站排在最前面。
• 附近：你周围各个车站的所有巴士，实时显示。站错马路了？在应用或小组件上点一下，就能看对面的车站。
• 地图：校园街道地图上，每条路线用自己的颜色显示。选一条路线就能看它的巴士实时移动；点车站看即将到站的车。看过一次后离线也能用。

它会学习，但先问你
• 总是赶不上去某节课的车？它会提议那节课早一班出发。
• 每周都跳过某节课？它会提议停止那节课的提醒。
你不同意就什么都不会改变，每个选择都可以撤销。

还有
• 今天：你的课、每节课什么时候出发，以及回家的行程。
• 支持英文和简体中文。
• 可以配合 terminus 的 Mac 菜单栏应用和网站使用，iPhone 也可以。添加邮箱后，它们都显示同一段行程。

注重隐私
• 不用注册：应用会自己创建一个账户。添加邮箱是可选的，只有想在其他设备上使用 terminus 时才需要。
• 你使用应用或点小组件按钮时，会用位置找附近的车站、在地图上显示你的位置；只有打开“上车时自动识别”后，行程中才会用到位置。terminus 只保留它代表的意思（已上车、错过了、已到达），从不保存你去过哪里。
• 没有广告、没有追踪、没有分析 SDK。
• 可以在设置里下载 terminus 保存的你的所有数据。可以在设置里删除你的账户和所有数据（添加邮箱后在账户页面删除），或只清除行程记录。

terminus 是独立开发的应用，并非由新加坡国立大学（NUS）制作、认可，也与其没有关联。巴士时间来自 NUS 公开的校车数据。
```

## Screenshots

Upload in this order. English in `screenshots/`, Chinese in `screenshots/zh/`, all 1080×1920 (Play's phone limit is a 2:1 ratio, so the 1280×2856 emulator screen was set to `wm size 1080x1920`, density 420).

1. `1-leave-by.png`: when to leave for the next class, counting down, and the whole trip on a line: the walk, the bus in its colour, and when you get there.
2. `2-widget.png`: the widget on the home screen, the trip on a line, with its buttons.
3. `3-places.png`: a place from search keeps its tab (with ×), its trip drawn the same way.
4. `4-on-the-bus.png`: on the bus, with how far along the ride you are, the next stop and the arrival.
5. `5-nearby-widget.png`: Nearby on the widget, with the swap button for the stop across the road.

How they were taken: the dev stub started with a class at 10:00 (the `dev-stub-shots` launch config), moved to the morning with `/__stub/skip` and held there with `/__stub/freeze`; the emulator's clock set to the stub's time (`adb shell cmd alarm set-time`) and the status bar cleaned with SystemUI demo mode. The phone was placed a few minutes' walk from PGP with a test location provider (`adb shell appops set com.android.shell android:mock_location allow`, then `cmd location providers add-test-provider` and `set-test-provider-location`), since `adb emu geo fix` stops working once the clock has been moved. The stub remembers the day's trip, so restart it before going back to an earlier time.

## Category and contact

- Category: Maps & Navigation. Tags: public transport, commute.
- Email: the developer address on the Play account.
- Website: https://terminus.rcn.sh
- Privacy policy: https://terminus.rcn.sh/privacy

## Content and policy answers

- **Ads:** no.
- **App access:** everything works without special access. Reviewer note:
  "No sign-in needed: a fresh install makes its own account. Setup asks where you live and for a NUSMods timetable link; any public NUSMods share link works, or tap "I'll do this later" (or "Skip setup"). Bus times are live for NUS campus shuttles in Singapore time. Location is optional. 'Add an email' is optional and unlocks nothing extra on the phone."
- **Advertising ID:** no. The app doesn't declare `AD_ID`.
- **Target audience:** 18 and over (university students). Not designed for children.
- **Exact alarms:** `SCHEDULE_EXACT_ALARM` needs no declaration. The user allows it under "Alarms & reminders".
- **Location:** `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` only, never `ACCESS_BACKGROUND_LOCATION`. Every use starts from something the user does (the app open, a tap on the widget or the live notification), so it's while-in-use access, and the location foreground service runs only after such a tap. No background location declaration is needed; the foreground service one below is.
- **Account deletion URL:** https://terminus.rcn.sh/privacy (section "Your controls"): an account with an email is deleted from https://terminus.rcn.sh/account; one without is deleted in the app (Settings → Delete this account), and is deleted anyway 60 days after it was last used.
- **Data safety:** as given in Play Console:
  - Location: precise, collected, ephemeral, optional, App functionality.
  - Email: optional; Account management and App functionality.
  - User IDs, app interactions and user-generated content: required.
  - Device IDs: the push token, device name and app version.
  - Nothing is shared. Data is encrypted in transit, and deletion is available.

## Foreground service declarations

Play Console → App content → Foreground service permissions. Two permissions need one: `FOREGROUND_SERVICE_SPECIAL_USE` and `FOREGROUND_SERVICE_LOCATION`. `shortService` (the widget's buttons) has no permission and needs none. The videos are in `build/play/` (not in the repo): upload them to YouTube as unlisted, or to Drive with link sharing, and paste the links.

**Special use** (`LiveService`, the live notification):

- Description: "During a campus bus trip the user is taking, an ongoing notification shows when to leave, the bus to catch and a live countdown, and on the bus where to get off and when. It runs only while the user has turned on 'Live notification during trips', from the time to leave until the user arrives, and stops itself after. None of the typed foreground service types fit a transit countdown: it is not media, navigation of a route the user is following turn by turn, or data sync."
- Impact if deferred or stopped: "The countdown and the bus to catch would be out of date by the time the user looks, and they would miss the bus the notification is telling them to catch."
- Video: `build/play/fgs-live-notification.mp4`.

**Location** (`LiveService` with "Notice when I board", and `WidgetModeService`):

- Description: "1) With 'Notice when I board' turned on, during a trip that a tap started (opening the app, or tapping its notification or widget), the live notification reads the location to tell whether the user has boarded the bus, missed it, or arrived, and updates the plan on their other devices. 2) Tapping Nearby or a place on the home screen widget takes one location fix to show the buses near the user or the quickest way from where they are. Both start only from a user's tap, and the app never requests background location."
- Impact if deferred or stopped: "The trip would not notice the user boarding or missing the bus, so the notification and widget would show the wrong next step; a widget tap would show buses near the user's home instead of where they are."
- Video: `build/play/fgs-location.mp4`.

## Before the first upload: app signing

Play App Signing re-signs apps with its own key unless told otherwise, and an APK signed with another key can't update the one already installed. People who installed terminus from the website or GitHub would have to uninstall it (losing an email-less setup) to move to Play. So when Play Console first asks how to sign, choose **Use your existing app signing key** ("Export and upload a key from Java keystore"), and upload the release key (`TERMINUS_KEYSTORE` in `~/.gradle/gradle.properties`) with Google's PEPK tool. This can't be changed after the first upload.
