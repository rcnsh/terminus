# An app starts with an anonymous account; an email is optional

The server needs an account to keep a profile, plan trips and send pushes, but an app shouldn't need an email before it's useful. So a new install gets an account with no email (POST /api/auth/anon), deleted after 60 days unused (24d70888). Adding an email later is approved from the email. If the address already has an account, the setups are kept, moved or merged as the user chooses.
