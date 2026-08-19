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
- with fewer than 3 days logged, skips claiming a "trend" (not enough data for that) and
  instead gives one specific, evidence-based tip for whichever pillar is lowest in the
  most recent entry — so a brand-new user still gets something useful on day one, not
  just "check back later"
- never uses emoji in its output
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

`POST /api/talk` with a body like:

```json
{ "message": "I'm nervous about a game coming up", "history": [], "recentContext": {"energy": 79, "stress": 68, "sleep": 70, "motivation": 85} }
```

powers "Talk to Bloom" — an open-ended chat where an athlete describes their situation in
their own words instead of picking from structured options. This is deliberately the most
locked-down endpoint in this file, because it's the one place someone could type something
genuinely sensitive. The system prompt keeps it strictly scoped to athletic wellbeing
(burnout, stress, sleep, motivation, team/school balance) and redirects anything unrelated;
it never diagnoses or claims to be a therapist or counselor; and if a message suggests real
distress — self-harm, suicidal thoughts, abuse, disordered eating, any crisis — Claude is
instructed to respond with care and point directly to a trusted adult or a real crisis line
rather than trying to handle it conversationally. Every response includes a `"concern"`
boolean so the frontend can show a prominent resource card (988 Suicide & Crisis Lifeline,
Crisis Text Line) on top of whatever Claude says, any time that flag is true — belt and
suspenders, not relying on the model alone. `history` is the last few turns of the
conversation (capped at 8 on both ends) so replies stay contextual without the payload
growing unbounded. The frontend also enforces a small daily message cap per device (25/day)
as a lightweight, disclosed cost and abuse guard on what is a real, metered API key — and
keeps actual message text in memory only, never in `localStorage`, so a sensitive
conversation doesn't persist after the tab closes. If this endpoint is unreachable, the
frontend shows a plain, non-alarming fallback message that still includes the crisis-line
numbers, rather than failing silently.

## Bloom Together (friend streaks + encouragement)

`POST /api/social/register`, `POST /api/social/connect`, `POST /api/social/checkin`,
`GET /api/social/state`, and `POST /api/social/encourage` power "Bloom Together" — the one
part of this app where more than one person's device talks to the same server-side state.
This is deliberately the most restrained social feature possible for a minors-facing
wellbeing app:

- **No pillar scores are ever sent to or through this feature.** The client only ever posts
  a check-in *date* (`dateKey`, e.g. `"2026-8-19"`) — never energy/stress/sleep/motivation
  values — so it's structurally impossible for one friend to see another's actual wellbeing
  numbers, not just a UI choice that could be worked around.
- **No freeform messages between users, ever.** "Encourage" always sends ONE of a fixed,
  curated set of supportive phrases, picked server-side at random — the client can't send
  arbitrary text to another user. Freeform peer-to-peer messaging is a real harassment vector
  between minors that the Talk-to-Bloom guardrails don't cover (those only apply to the
  user-to-AI conversation), so it's simply not offered here.
- **No accounts.** Just a self-chosen nickname (no real name required) and a short invite
  code to connect with a friend — consistent with the rest of the app.
- A friend "streak" is the number of consecutive days (most recent first) where *both*
  people checked in — same logic as the personal streak, and it can go cold if either person
  misses a day. That's an intentional, contained exception to the app's usual
  never-punish-a-lapse rule: it's a separate, opt-in social layer, and a missed day here never
  touches either person's own Buddy evolution, personal streak, or badges, which are computed
  entirely independently.

Data lives in `social-data.json` next to this file (auto-created, gitignored) rather than
purely in memory — Render's free tier spins the server down after ~15 minutes idle, which
would wipe pure in-memory state on almost every wake-up. A file survives that, though not
necessarily a fresh redeploy depending on Render's disk behavior. This is a fine store for a
friend group testing it; swap it for a real hosted database before this needs to support more
than that. There's also no real authentication beyond knowing a random ID/invite code — fine
among real-life friends for an MVP, not a security boundary.

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
