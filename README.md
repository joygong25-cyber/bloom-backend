# Bloom AI Insights backend

This is the real version of the prototype's "AI Insights" screen. Instead of the
rule-based JavaScript that runs entirely in the browser, this small server sends your
check-in history to the actual Claude API and returns Claude-generated alerts and a
wellbeing-over-time summary.

No npm install needed — it only uses Node's built-in `http` module and the global
`fetch` that ships with Node 18+.

## 1. Get an Anthropic API key

Go to [console.anthropic.com](https://console.anthropic.com), sign in, and create an
API key under **API Keys**.

**Important — this needs an adult.** Anthropic requires account holders to be 18 or
older, and API usage is billed (a small pay-as-you-go cost per request — this app's
usage is a few cents at most even with frequent check-ins). You'll need a parent or
guardian to create the account, add a payment method, and either share a key with you
or generate one for you to use. Don't paste a real API key into a chat, text message,
or anywhere public — treat it like a password.

## 2. Configure

```
cp .env.example .env
```

Open `.env` and paste your real key in place of `your_key_here`.

## 3. Run it

```
node server.js
```

You should see:

```
Bloom AI Insights backend listening on http://localhost:3001
  API key configured: true
```

Check it's working:

```
curl http://localhost:3001/health
```

## 4. Point the app at it

In the prototype HTML, the AI Insights screen tries to fetch from
`http://localhost:3001/api/insights` first. If that fails (server not running, wrong
URL, no key), it automatically falls back to the local rule-based version — so the
prototype still works as a demo even without this backend running.

If you deploy this server somewhere (see below), update that URL in the HTML to your
deployed server's address instead of `localhost`.

## Deploying it for real (so it works outside your own computer)

Running `node server.js` only works while your computer is on and the terminal is
open. To have this actually running all the time — which you'd need for real push
notifications — deploy it to a free host:

- **Render** (render.com) — genuinely free, no credit card required: 750 instance-hours/month,
  which is enough to run this continuously. The only catch is it spins down after 15 minutes
  of no traffic and takes about a minute to wake back up on the next request — a minor
  one-time wait for a check-in app that's only hit a few times a day, not a real problem.
  Connect a GitHub repo, set `ANTHROPIC_API_KEY` as an environment variable in their
  dashboard (don't commit your `.env` file).
- Railway and Fly.io are no longer good options for this — both dropped their free
  always-on tiers and now require a payment method for anything but trivial trial usage.

To deploy: push this folder to a GitHub repo, connect it in Render's dashboard as a Web
Service, set the `ANTHROPIC_API_KEY` environment variable there (not in a committed file),
and it'll give you a public URL like `https://your-app.onrender.com` — swap that in for
`localhost:3001` in both `AI_BACKEND_URL` and `AI_FOLLOWUP_URL` near the top of the
check-in app's `<script>` block.

## What it actually does

`POST /api/insights` with a body like:

```json
{
  "history": [{"date": "...", "energy": 80, "stress": 58, "sleep": 38, "motivation": 97}, ...],
  "streak": 6,
  "longestStreak": 9
}
```

sends that data to Claude with a system prompt that:
- grounds every statement in the real numbers (no invented data)
- avoids clinical/diagnostic language — it surfaces patterns, it doesn't diagnose
- only suggests talking to a trusted adult when the data genuinely warrants it, not by
  default
- returns strict JSON: `{"alerts": [...], "narrative": "..."}`

You can change the model in `.env` via `CLAUDE_MODEL` — defaults to
`claude-haiku-4-5-20251001` (fast and cheap). Swap to `claude-sonnet-5` for more
nuanced analysis. Model names change over time — check
[the current list](https://platform.claude.com/docs/en/about-claude/models/overview)
if requests start failing with a model-not-found error.

`POST /api/followup` with a body like:

```json
{ "pillar": "energy", "pillarLabel": "Energy", "value": 5, "label": "Amped" }
```

powers the check-in's "what's contributing?" step. It fires the moment someone picks an
answer, and Claude decides — per that specific answer — whether to ask a follow-up at all,
what to ask, and what options make sense, instead of the app showing a fixed list. A low
answer gets asked about stressors (grounded in the Athlete Burnout Questionnaire's
exhaustion / reduced-accomplishment / devaluation dimensions); a high answer gets asked
what's contributing positively instead (grounded in Fredrickson's broaden-and-build theory,
and Self-Determination Theory for Motivation) — it will never show deficit options for a
good answer. A middle/neutral answer is usually skipped rather than forcing a question with
no real signal behind it. Returns strict JSON: `{"question": "...", "chips": [...], "skip":
false}`. If this server isn't running, the frontend falls back to a science-grounded local
map instead of the old one-size-fits-all list — see `NEGATIVE_CONTRIBUTORS` /
`POSITIVE_CONTRIBUTORS` in the HTML file.

## Notifications

This server only answers when asked (`POST /api/insights`) — it doesn't push anything
on its own. To get real push notifications (to a phone, even with the app closed),
you'd add:
- a scheduled job (e.g. a cron job, or Render's cron jobs) that calls this endpoint
  once a day per user
- a push notification service (Firebase Cloud Messaging for a mobile app, or Web Push
  for a browser-based one) to actually deliver Claude's alert text to the device

That's real, additional infrastructure beyond this repo — this server is the "brain"
that decides what to say; a push service is the separate "delivery truck."
