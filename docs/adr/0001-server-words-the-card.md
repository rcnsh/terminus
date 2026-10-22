# The server works out and words the card; clients only count down

Every client used to word the answer itself, and four clients drift apart: one would show a guessed time as live, or a minute count frozen when stale. So `/api/me/next` returns a finished card (headline, leave-by, heading, journey sentences, reminder time, "~" on estimates), and the web app, Android and the Mac only draw it and count down its clock (82e4cae4, f13775cb). New behaviour goes into the server, even when one client could do it more easily alone.
