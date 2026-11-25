# Webinar Dashboard Template

A free, open template for running a webinar funnel from one dashboard. It walks a business
through everything needed to launch a webinar, connects its tools, and then tracks every
person from sign-up to sale.

There is **no login by default**. Anyone with the address can open it until you choose to add
a password (it takes one setting, see "Adding a password" below).

## What it does

| Page | What it is |
|---|---|
| `/` | **Setup.** Seven guided steps, one question per screen, saved as you go: your webinar, your audience, your offer and proof, your tools, your look, the build, go live. Includes a three minute walkthrough video and voice typing in every text box (Chrome). |
| `/results` | **Results.** Everyone who signed up in a period, followed step by step (visited, signed up, came live, stayed to the offer, booked a call, turned up, bought), the biggest leak in one sentence, and what to fix first. Add `?demo=1` to see sample data. |
| `/settings` | **Settings.** Change a tool, a target or a key later, test every connection, copy the build key and the sign-up addresses. |
| `/login` | Only used if you turn the password on. |

**Connections it supports**

* Webinar platform: WebinarJam, EverWebinar, eWebinar, aEvent
* Contacts (CRM): GoHighLevel, Close
* Booking calendar: Calendly
* Payments: Stripe, Whop, Commas, PayPal, GoHighLevel, Kajabi, Lemon Squeezy, Paddle
* Ads: Meta (Facebook and Instagram) ad spend and results
* Alerts: a Slack or Discord incoming webhook when something needs attention

An hourly update pulls fresh numbers from every connected tool. Anything a tool cannot tell
us shows as "not known", never as zero. Your landing pages send sign-ups to the dashboard, which
saves them, adds them to your CRM and registers them on your webinar platform.

## What you need

* A free [Vercel](https://vercel.com) account (hosting) and a free Upstash Redis database
  (added from inside Vercel in one click)
* [Node.js](https://nodejs.org) 18 or newer on your computer
* The keys for whichever tools you use. You paste these into the app itself, with step by step
  instructions for each tool. You do not need them to get started.

## Setup, step by step

1. **Get the code.** Click "Use this template" on GitHub (or download the ZIP), then open a
   terminal in the folder.
2. **Install.**
   ```bash
   npm install
   ```
   There are no outside packages, so this is quick.
3. **Create your secrets.** This writes a private file called `client.env` with three random
   keys the app needs (`APP_SECRET`, `BUILD_KEY`, `CRON_SECRET`). Use your own business name
   and timezone:
   ```bash
   node scripts/configure.js --name "Your Brand" --tz Europe/London --currency "£"
   ```
   `client.env` is ignored by git. Never commit it.
4. **Try it on your computer.**
   ```bash
   npm run dev
   ```
   Open http://localhost:3210 in your browser. Everything you save locally goes into a
   `.data/` folder (encrypted). Delete that folder to start again.
5. **Check it.**
   ```bash
   npm run build
   ```
   There is nothing to compile: this checks every file and runs the test suite.

## Deploy to Vercel

1. Install the Vercel command line tool once: `npm i -g vercel`
2. In the project folder:
   ```bash
   vercel link                 # create or pick a Vercel project
   node scripts/push-env.js    # sends client.env to Vercel (values go over stdin, not the command line)
   vercel --prod
   ```
3. In the Vercel dashboard open your project, then **Storage**, add **Upstash Redis**, connect
   it to this project, and redeploy (`vercel --prod`). That database is the only storage the
   app needs; Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
4. Open your site address and work through Setup.

Step 3 of Setup (`configure.js`) also writes the hourly update schedule into `vercel.json`
(Vercel Cron, 24 daily jobs so it works on the free plan). "Refresh now" on Results runs the
same update on demand.

## Adding a password (optional)

By default the dashboard is open to anyone who knows its address, which includes your tool
settings and the build key. If the address could be seen by others, turn on a password.
Pick ONE of these:

* **One shared password.** Set `ACCESS_PASSWORD` to a password you choose, then redeploy.
  ```bash
  vercel env add ACCESS_PASSWORD production   # it asks you to type the value
  vercel --prod
  ```
  Everyone signs in with that password. To change it, change the env var and redeploy; every
  device is signed out.
* **The owner chooses their own password.** Run `node scripts/configure.js --with-login`, which
  adds a one-time `SETUP_CODE` to `client.env`, push it with `node scripts/push-env.js`, and
  redeploy. On the first visit the owner types that code and picks a password, which they can
  change later on Settings.

To remove the password again, delete the env var in Vercel and redeploy. No password is ever
stored in this code. When previewing locally, `npm run dev -- --no-login` ignores both settings.

## Settings reference

Only `APP_SECRET`, `BUILD_KEY` and `CRON_SECRET` must be set (`configure.js` makes them), plus
the optional `ACCESS_PASSWORD` or `SETUP_CODE`. Everything else, such as your brand name,
timezone, currency, tool keys and targets, is entered in the app and can also be preset as an
env var. `.env.example` lists every one with a short note. Do not change `APP_SECRET` once
the app is in use: everything saved is encrypted with it.

**Optional "Open in Google Docs" buttons.** Each questionnaire in Setup can offer a Google Docs
copy. Publish your own copy of a questionnaire as a Google Doc anyone can view, then put its id in
`api/_lib/gdocs.json` (for example `{"offer": "<doc id>"}`) or in `QUESTIONNAIRE_DOCS_JSON`.
With no ids the button is simply hidden.

## Use it with Claude Code (optional)

This repo includes a Claude Code skill that sets the template up for you step by step.

```bash
./install.sh
```

That copies `skill/` to `~/.claude/skills/webinar-dashboard`. Then in Claude Code say
"set up the webinar dashboard" or type `/webinar-dashboard`.

## How it works (for the curious)

**Sign-in.** Optional (see "Adding a password" above). With `ACCESS_PASSWORD` the password is
compared on the server and a signed, HttpOnly cookie lasts 30 days; changing the env var signs every
device out. With `SETUP_CODE` the owner's chosen password is stored as a salted scrypt hash.
The sign-up, survey and health routes are always open. The build scripts use `BUILD_KEY`.

**Storage.** `api/_lib/db.js` keeps named tabs of rows in Redis (files under `.data/` locally).
Each tab has a part a sync rewrites (stored in chunks of 400 rows) and a part rows are appended
to (a capped list), so a sign-up arriving while a sync runs is never lost. Settings, answers,
the build board and the password hash are encrypted with `APP_SECRET` (`settings-store.js`).

**The hourly update.** Vercel's schedule calls `/api?action=cron`, which reads each connected
tool into its tabs: the webinar platform, Meta ads, Calendly, and the payment tool (Stripe, Whop, Commas, PayPal, GoHighLevel, Kajabi, Lemon Squeezy or Paddle). "Refresh now" on Results
does the same on demand.

**Results.** `api/_lib/results.js` follows everyone who signed up in the period: visits → signed
up → came live → stayed to the offer → booked a call → turned up → bought. A call counts as
"turned up" once its time has passed unless it was cancelled or marked a no-show in Calendly;
"bought" is a payment by the same email after signing up, read from the payment tool or sent by it to the sales address (or a purchase the webinar
platform reported). Anything a tool cannot tell us reads "not known", never zero.

### What each webinar platform can tell us

| | WebinarJam / EverWebinar | eWebinar | aEvent |
|---|---|---|---|
| How it connects | a 64 character key | a key starting `ew_api_` (needs the Registrants permission) | the session token of a logged-in user, **which stops working when that user logs in again** |
| Who came live | yes | yes | yes |
| How long they watched | minutes | percent | no |
| Stayed to the offer | from minutes + "minute the offer starts" | "stayed till the end", else percent + "percent where the offer starts" | no |
| Replay, purchases | yes | yes | no |
| Where they came from (UTM) | yes | yes | no (the sign-up route supplies it) |
| Sign people up for us | yes | not confirmed, skipped | no, skipped |

aEvent has no public API; its adapter follows what the aEvent web app calls. eWebinar keeps its
reference behind a login; the top of `api/_lib/sync/webinar/ewebinar.js` lists what is confirmed
and what is not.

## API the skill's scripts use

```bash
curl "$SITE/api?action=intake" -H "Authorization: Bearer $BUILD_KEY"
# → { status, intake: {…}, design: {…}, tools: {…}, progress, design_chosen, complete, missing: [fields], catalogue }

curl -X POST "$SITE/api?source=intake" -H "Authorization: Bearer $BUILD_KEY" -H "Content-Type: application/json" \
  -d '{"intake": {"business_name": "Acme Coaching"}, "design": {"preset": "dark_bold"}}'

curl "$SITE/api?action=build_status" -H "Authorization: Bearer $BUILD_KEY"
# → { status, statuses, items: [{ id, label, status, link, note, updated_at }], counts }

curl -X POST "$SITE/api?source=build_status" -H "Authorization: Bearer $BUILD_KEY" -H "Content-Type: application/json" \
  -d '{"items": [{"id": "landing_page", "status": "needs_review", "link": "https://…", "note": "Draft ready"}]}'
```

Statuses: `not_started`, `in_progress`, `needs_review`, `done`, `blocked`. Board ids: `intake,
access, messaging, landing_page, confirmation_page, landing_video, confirmation_video,
breakout_videos, pre_emails, post_emails, sms, call_sequences, ad_scripts, static_ads,
webinar_script, crm_loaded, platform_wired, pages_published, tracking_live, e2e_test`. An id
that is not on the board yet is created.

## Public routes (the funnel pages post here; no key in the page)

```bash
curl -X POST "$SITE/api?source=register" -H "Content-Type: application/json" -d '{
  "first_name": "Jane", "email": "jane@example.com", "phone": "+44 7700 900000", "webinar_id": "", "session": "",
  "utm_source": "facebook", "utm_medium": "paid", "utm_campaign": "launch", "utm_content": "ad-1", "utm_term": "",
  "fbclid": "", "page_url": "https://go.example.com/webinar", "funnel_source": "paid", "company_website": "" }'
# → { ok, status, join_url?, redirect, steps: [{ name: "crm"|"platform"|"sheet", status: "ok"|"skipped"|"error", message }] }

curl -X POST "$SITE/api?source=survey" -H "Content-Type: application/json" -d '{
  "email": "jane@example.com", "answers": [{"question": "What is your biggest challenge?", "answer": "Not enough leads"}], "company_website": "" }'
# → { ok, status, steps: [{ name: "sheet"|"crm", status, message }] }
```

`company_website` is a honeypot: leave it empty. A CRM or platform failure never loses the
sign-up: it is still saved, and the failure goes to the alerts address if one is set. 400 =
invalid (`fields` says which), 403 = the page's site is not on the allowed list, 429 = slow
down, 500 = nothing could be saved. Other tools can push webinar data to
`POST /api?source=event` (Bearer the secret saved under `EVENT_INGEST_SECRET`, or `&key=`):
`type` = `webinar_registered | webinar_attended | webinar_stayed | webinar_replay |
webinar_purchase`, a whole sign-up as `type: "webinar_registrant"`, or a platform's own message
with `&provider=ewebinar`.

## Layout

```
api/index.js                 the one serverless function; routes by ?action= / ?source=
api/_lib/auth.js             the optional sign-in
api/_lib/settings-store.js   settings, encrypted documents, rate limits, the Redis / file backends
api/_lib/db.js               the data store (tabs of rows)
api/_lib/results.js          the funnel maths, the biggest leak, what to fix first
api/_lib/demo.js             sample data for Results
api/_lib/handlers/           setup (answers, look, build board, go live), settings, register, event
api/_lib/sync/               the hourly update: webinar/ (one file per platform), ads/, calendly, payments (one adapter per payment tool; stripe has its own file)
api/_lib/crm-write.js        saves a sign-up to GoHighLevel or Close
public/                      the four pages, theme.css (shared look), app.css, voice.js, tools.js
scripts/                     configure, dev, push-env, set-cron, check
skill/SKILL.md               a Claude Code skill that sets this template up for you (install.sh copies it)
test/                        node --test
```

Files under `api/` must stay inside `api/_lib/`: every other file there becomes its own
serverless function and the free Vercel plan allows 12.

## Extending

- **Another webinar platform**: one new file and one registry line. Write
  `api/_lib/sync/webinar/<name>.js` exporting `id`, `label`, `connected()`, `test()`,
  `listWebinars()`, `pull(ctx, opts)` and `mapRegistrant(raw)` (the standard row is described at
  the top of `sync/webinar/index.js`), plus `register(person)` or a `REGISTER_UNSUPPORTED`
  sentence. Add `<name>: () => require('./<name>')` to `ADAPTERS` in `sync/webinar/index.js`.
  It reads its key from `config.webinar.api_key`. To show it in Setup, add a tile and a card to
  `public/tools.js`. Leave a value `null` when the platform does not report it.
- **Another ad platform**: the same shape under `api/_lib/sync/ads/`.

`npm run check` then `npm test` after any change.

## Extending

- **Another webinar platform**: one new file and one registry line. Write
  `api/_lib/sync/webinar/<name>.js` exporting `id`, `label`, `connected()`, `test()`,
  `listWebinars()`, `pull(ctx, opts)` and `mapRegistrant(raw)` (the standard row is described at
  the top of `sync/webinar/index.js`), plus `register(person)` or a `REGISTER_UNSUPPORTED`
  sentence. Add `<name>: () => require('./<name>')` to `ADAPTERS` in `sync/webinar/index.js`.
  It reads its key from `config.webinar.api_key`. To show it in Setup, add a tile and a card to
  `public/tools.js`. Leave a value `null` when the platform does not report it.
- **Another ad platform**: the same shape under `api/_lib/sync/ads/`.

## Before you change code

`npm run check` then `npm test` (or `npm run build`, which runs both).

## License

MIT. See `LICENSE`.
