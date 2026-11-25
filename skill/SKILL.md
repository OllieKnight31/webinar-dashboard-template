---
name: webinar-dashboard
description: Sets up the open source Webinar Dashboard Template for a user, step by step. Gets the code, creates the secrets, previews it locally, deploys it to Vercel with Upstash Redis, optionally adds a password, and helps connect the webinar platform, CRM, calendar, payments and Meta ads. Use when the user says "set up the webinar dashboard", "deploy the webinar dashboard template", "/webinar-dashboard", or asks to install or configure this template.
---

# Webinar Dashboard: guided setup

You are setting up the Webinar Dashboard Template for someone who may not be technical. Go one
step at a time, explain each step in a sentence, run the commands for them, and confirm each
step worked before moving on. Never print secret values back in chat. Write prose without em
dashes or en dashes.

## Facts about the template

* Plain Node.js, no framework, no npm dependencies, no compile step. Node 18 or newer.
* Pages: `/` Setup (seven guided steps), `/results` (funnel report, `?demo=1` for sample data),
  `/settings`, `/login` (only when a password is turned on).
* One serverless function: `api/index.js`. Storage: Upstash Redis on Vercel, `.data/` locally.
* Required env vars: `APP_SECRET`, `BUILD_KEY`, `CRON_SECRET` (made by `scripts/configure.js`).
* Optional sign-in: `ACCESS_PASSWORD` (one shared password) or `SETUP_CODE` (owner picks a
  password on first visit). With neither, there is NO login and everything is open.
* Tool keys (WebinarJam, eWebinar, aEvent, GoHighLevel, Close, Calendly, Stripe and other payment
  tools, Meta ads) are normally pasted into the app on Setup step 4 or Settings, which show
  numbered instructions for each tool. `.env.example` lists them all if the user prefers env vars.

## Steps

1. **Get the code.** If the user is not already in a copy of the repo, ask where they want it and
   run `git clone https://github.com/OllieKnight31/webinar-dashboard-template.git <folder>`
   (or, if they want their own GitHub copy, `gh repo create <name> --template OllieKnight31/webinar-dashboard-template --private --clone`).
   `cd` into it.
2. **Check Node.** `node --version` must be 18 or newer. If not, tell them to install the LTS
   from nodejs.org and stop until it is done.
3. **Install and verify.** `npm install` then `npm run build` (syntax check plus the test suite).
   Both must pass.
4. **Ask three questions:** business name, timezone (Region/City, for example Europe/London),
   currency symbol. Then run
   `node scripts/configure.js --name "<name>" --tz <tz> --currency "<symbol>"`.
   This writes `client.env` (gitignored) and the hourly schedule in `vercel.json`.
5. **Ask about a password.** Explain: by default anyone with the address can open the dashboard,
   including tool settings and the build key. Offer three choices:
   * no password (fine for a private, unshared address or a test),
   * one shared password: ask them to choose it, then run
     `node scripts/configure.js --set ACCESS_PASSWORD=<their password>` (do not echo it back),
   * owner chooses their own: `node scripts/configure.js --with-login` and tell them the setup
     code it prints is needed once on the first visit.
6. **Preview locally.** `npm run dev`, then open http://localhost:3210 in the user's browser.
   Suggest `/results?demo=1` to see what the report looks like. Stop the server when done.
7. **Deploy to Vercel.**
   * `vercel --version` (if missing: `npm i -g vercel`), then `vercel login` if needed.
   * `vercel link` to create or choose a project.
   * `node scripts/push-env.js` to send `client.env` to Production.
   * `vercel --prod`.
   * Tell the user to open the project in the Vercel dashboard, go to Storage, add Upstash Redis,
     connect it to this project, then run `vercel --prod` again. Wait for them to confirm.
   * Check `<site>/api?action=health` reports `"storage":"connected"`.
8. **Connect tools.** Walk them through Setup on the live site. Step 4 connects each tool, with
   a "Check connection" button. Afterwards Settings has "Test every connection".
9. **Connect the funnel pages.** Their landing page posts sign-ups to
   `POST <site>/api?source=register` and the confirmation page survey to
   `POST <site>/api?source=survey` (both addresses are on Settings, with copy buttons; the
   README shows the JSON shape). Optionally restrict which sites may post in Settings.
10. **Finish.** Summarise: site address, whether a password is on, which tools are connected,
    and what is still to do. Remind them never to commit `client.env` and never to change
    `APP_SECRET` once in use.

## Changing the password later

* Shared password: `vercel env rm ACCESS_PASSWORD production`, `vercel env add ACCESS_PASSWORD production`, then `vercel --prod`.
* Remove the login entirely: delete `ACCESS_PASSWORD` and `SETUP_CODE` in Vercel, redeploy.

## Troubleshooting

* "APP_SECRET is missing": run `node scripts/push-env.js --env-only` and redeploy.
* "Nowhere to save yet": Upstash Redis is not connected to the project; connect it and redeploy.
* Hourly update not running: `CRON_SECRET` must be set in Vercel; "Refresh now" on Results runs it by hand.
* After any code change: `npm run build`.
