// Bloom AI Insights backend — a small, dependency-free Node server that calls the real
// Anthropic Messages API to analyze a user's check-in history and return:
//   1) a short list of grounded, specific alerts (not generic praise/quotes)
//   2) a short "wellbeing over time" narrative paragraph
//
// This is the real version of what the prototype's "AI Insights" screen mocked with
// local JS rules. Wire the frontend's fetch call at this server's URL (see README) and
// it will call Claude for real instead of the rule-based fallback.
//
// No npm install required — uses Node's built-in http server and global fetch (Node 18+).

const http = require("http");
const fs = require("fs");
const path = require("path");

// Tiny built-in .env loader so nothing needs to be npm-installed. Looks for a .env file
// next to this script and copies KEY=VALUE lines into process.env (without overwriting
// anything already set in the real environment).
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.ANTHROPIC_API_KEY;
// claude-haiku-4-5 is fast and cheap — plenty for this task. Bump to claude-sonnet-5 in
// your .env if you want richer, more nuanced analysis (check current model IDs at
// https://platform.claude.com/docs/en/about-claude/models/overview since they change).
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are a data analyst for Bloom, a teen athlete wellbeing check-in app grounded in athlete-burnout research (the Athlete Burnout Questionnaire's exhaustion / reduced-accomplishment / devaluation dimensions, plus sleep and perceived stress-recovery balance from adolescent-athlete studies, and Self-Determination Theory for motivation specifically).

You will be given a user's daily check-in scores (0-100) across 4 pillars — Energy, Stress Balance, Sleep, Motivation — for however many days they've actually logged (could be as few as 1), plus their current check-in streak.

Write:
1) A short list of specific, evidence-based alerts about patterns worth the user's attention.
2) One short paragraph summarizing their overall wellbeing trend over the period.

Rules:
- Ground every statement in the actual numbers you're given. Never invent data, never make up a number that isn't derivable from the input.
- If there are fewer than 3 days of check-ins, there is not enough data for a real trend — do not claim one. Instead, identify whichever pillar has the lowest score in the most recent entry and give ONE specific, evidence-based tip for improving that exact pillar (cite the relevant research briefly, the way a knowledgeable coach would, not with academic citations). The narrative should note plainly that this is an early read from limited data, not a trend, while still being useful today.
- Do not diagnose, use clinical/medical language, or claim to detect a disorder. You are surfacing patterns and giving practical tips, not making a diagnosis.
- Tone: direct, specific, and grounded. Never generic motivational quotes ("you've got this!"), never preachy, never repeat the same phrasing across alerts.
- Only if scores show a genuinely concerning pattern (a large multi-day drop, or a sustained decline across 2+ pillars) may you gently suggest talking to a coach, parent, or trusted adult — and only once, not in every alert. Do not do this by default.
- Keep it teen-appropriate, non-alarmist, and never longer than necessary.
- Never use emoji anywhere in your output.
- Output ONLY valid JSON matching this exact shape — nothing else, no markdown code fences, no commentary before or after, no "icon" field:
{"alerts":[{"severity":"good"|"warn","text":"<one sentence, specific, under 160 characters>"}],"narrative":"<2-4 sentences of plain text, may reference specific numbers>"}
Return between 1 and 4 alerts. If nothing in the data is concerning, return exactly one alert with severity "good" acknowledging steadiness — do not invent a warning just to have one.`;

// ---- Post-answer follow-up ("What's contributing?"). The old frontend-only version showed
// the exact same fixed, deficit-framed chip list ("Poor sleep", "Heavy training load"...) no
// matter what the athlete answered — so picking "Energized" still surfaced a list of negative
// causes. This is the actual instrument logic: the follow-up has to be valence-matched to the
// answer, or it's just noise. This prompt is where that decision lives now — Claude decides
// per-answer whether to ask at all, what to ask, and what options make sense, instead of the
// app picking from a static list.
const FOLLOWUP_SYSTEM_PROMPT = `You generate ONE short, optional follow-up prompt for a single pillar in Bloom, a teen athlete wellbeing check-in app. You'll be told which pillar (Energy, Stress Balance, Sleep, or Motivation), the label the athlete just picked (e.g. "Energized"), and its value from 1 (most negative) to 5 (most positive).

Ground your response in real research, and let the athlete's actual answer drive which direction you go:
- LOW answer (value 1-2): ask about plausible stressors/deficits for THIS pillar. Ground this in the Athlete Burnout Questionnaire (Raedeke & Smith, 2001) dimensions — exhaustion, reduced sense of accomplishment, sport devaluation — and, for Sleep/Stress Balance, adolescent-athlete sleep and stress-recovery research.
- HIGH answer (value 4-5): ask what's contributing to THAT instead. Never offer deficit or negative-sounding options when the athlete just said they feel good — that's the exact bug this endpoint exists to fix. Ground this in Fredrickson's broaden-and-build theory (2001) — positive emotions broaden thinking and build durable personal resources, so it's worth identifying what to repeat — and, for Motivation specifically, Self-Determination Theory (Deci & Ryan) — autonomy, competence, and relatedness as drivers of intrinsic motivation.
- MIDDLE answer (value 3): usually not a strong enough signal to interrogate. Default to skip:true with an empty question and empty chips rather than manufacturing a question with nothing meaningful behind it — but use your judgment; you're allowed to ask something light if the pillar and label genuinely warrant it.

Rules:
- Never mix positive and negative options in the same response.
- Chip options: 3-5 items, short (2-4 words), specific to the pillar, plain teen-appropriate language, no clinical language, no emoji.
- The question itself can be whatever wording actually fits best — you are not limited to rephrasing "What's contributing?". Change it entirely if a different question fits the answer better.
- Output ONLY valid JSON, nothing else, no markdown fences, no commentary:
{"question":"<short second-person question, or empty string if skip>","chips":["...", "..."],"skip":true|false}`;

// ---- "Talk to Bloom" — an open-ended, free-text conversation, unlike the structured
// /api/insights and /api/followup endpoints above. Because it's open-ended and aimed at
// teenagers discussing wellbeing/stress, the system prompt below is deliberately strict
// about scope and about never handling a real crisis disclosure by itself — see the rules
// section. Every response is flagged with a "concern" boolean so the frontend can surface
// real crisis resources immediately, on top of whatever Claude says.
const TALK_SYSTEM_PROMPT = `You are "Talk to Bloom," a supportive conversational feature inside Bloom, a teen athlete wellbeing check-in app grounded in athlete-burnout research. A teenage student-athlete (roughly 13-19) is describing something in their own words and wants a thoughtful, personalized response — not a form to fill out.

You may be given their recent check-in scores (Energy, Stress Balance, Sleep, Motivation, each 0-100) for context. Use them only if actually relevant to what they said, to sound like you're genuinely listening — never to make clinical claims from them.

SCOPE — stay in this lane:
- Athletic wellbeing: burnout, training stress, motivation, sleep, recovery, balancing sport with school, team/coach dynamics, performance pressure, goal-setting, and everyday feelings connected to being a student-athlete.
- If asked something clearly outside this (homework help, general trivia, coding, anything unrelated to their wellbeing as an athlete), briefly say that's outside what this feature is for and redirect back to what you can actually help with — don't coldly refuse, but don't answer off-topic requests either.
- Ground guidance in real research where it fits naturally (Athlete Burnout Questionnaire, Self-Determination Theory, sleep science, Goal-Setting Theory) the way a knowledgeable, warm coach would — not with academic citations, and not forced into every reply.

ABSOLUTE RULES:
- You are not a therapist, doctor, or counselor, and must never imply otherwise. Never diagnose. Never give medical, psychiatric, or clinical advice.
- If ANYTHING in the message suggests the person may be in real distress — self-harm, suicidal thoughts, abuse, disordered eating, or any crisis — do NOT try to handle it yourself, do NOT ask probing/investigative questions, and do NOT just continue the conversation as normal. Respond with warmth and directness: acknowledge what they shared in one sentence, and clearly encourage them to reach out to a trusted adult, a school counselor, or a crisis line right now. Set "concern" to true whenever you do this — err on the side of flagging it if you're at all unsure.
- Never encourage or normalize disordered eating, training or competing through real injury/pain, or ignoring a coach/parent/doctor's actual guidance.
- Keep responses conversational but concise — 2-5 sentences typically, not an essay.
- Never use emoji.
- Tone: warm, direct, like a smart older teammate who happens to know the research — never preachy, never a generic pep-talk ("you've got this!"), never repeats itself.

Output ONLY valid JSON, nothing else, no markdown fences, no commentary:
{"reply":"<your response, plain text, 2-5 sentences typically>","concern":true|false}`;

function buildTalkUserMessage(payload) {
  var contextLine = "";
  if (payload.recentContext && typeof payload.recentContext === "object") {
    contextLine = `Their most recent check-in, for context — use only if relevant: ${JSON.stringify(payload.recentContext)}\n\n`;
  }
  var historyText = "";
  if (Array.isArray(payload.history) && payload.history.length) {
    historyText =
      "Conversation so far (oldest first):\n" +
      payload.history
        .slice(-8)
        .map((m) => (m.role === "user" ? "Athlete: " : "Bloom: ") + String(m.text || "").slice(0, 600))
        .join("\n") +
      "\n\n";
  }
  return (
    contextLine +
    historyText +
    `Athlete's new message: "${String(payload.message).slice(0, 2000)}"\n\n` +
    `Respond with the JSON object described in your instructions — nothing else.`
  );
}

async function callTalk(payload) {
  const parsed = await callClaudeAPI(TALK_SYSTEM_PROMPT, buildTalkUserMessage(payload), 500);
  if (typeof parsed.reply !== "string") {
    throw new Error("Claude's response was valid JSON but not in the expected shape.");
  }
  parsed.concern = !!parsed.concern;
  return parsed;
}

function buildUserMessage(payload) {
  return (
    `Here is the user's last ${payload.history.length} check-ins (oldest first). ` +
    `Each pillar score is 0-100, where higher is better in every case. ` +
    `Current check-in streak: ${payload.streak} days (longest ever: ${payload.longestStreak} days).\n\n` +
    `Check-in history (JSON):\n${JSON.stringify(payload.history, null, 0)}\n\n` +
    `Analyze this and respond with the JSON object described in your instructions — nothing else.`
  );
}

function buildFollowupUserMessage(payload) {
  return (
    `Pillar: ${payload.pillarLabel} (key: ${payload.pillar}).\n` +
    `The athlete just answered with "${payload.label}" — value ${payload.value} out of 5 (1 = most negative, 5 = most positive).\n\n` +
    `Generate the follow-up JSON described in your instructions — nothing else.`
  );
}

// Shared call to the real Anthropic Messages API. Returns Claude's parsed JSON response;
// callers validate their own expected shape.
async function callClaudeAPI(systemPrompt, userMessage, maxTokens) {
  if (!API_KEY) {
    const err = new Error(
      "ANTHROPIC_API_KEY is not set. Add it to a .env file or export it before starting the server — see README.md."
    );
    err.code = "NO_KEY";
    throw err;
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const raw = await resp.json();

  if (!resp.ok) {
    const msg = raw && raw.error && raw.error.message ? raw.error.message : JSON.stringify(raw);
    const err = new Error("Anthropic API error (" + resp.status + "): " + msg);
    err.code = "API_ERROR";
    throw err;
  }

  const textBlock = (raw.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text content in Claude's response.");

  // Claude is instructed to return raw JSON, but strip code fences defensively in case it adds them.
  let cleaned = textBlock.text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  }

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const err = new Error("Could not parse Claude's response as JSON: " + cleaned.slice(0, 200));
    err.code = "PARSE_ERROR";
    throw err;
  }
}

async function callClaude(payload) {
  const parsed = await callClaudeAPI(SYSTEM_PROMPT, buildUserMessage(payload), 700);
  if (!Array.isArray(parsed.alerts) || typeof parsed.narrative !== "string") {
    throw new Error("Claude's response was valid JSON but not in the expected shape.");
  }
  return parsed;
}

async function callFollowup(payload) {
  const parsed = await callClaudeAPI(FOLLOWUP_SYSTEM_PROMPT, buildFollowupUserMessage(payload), 300);
  if (typeof parsed.question !== "string" || !Array.isArray(parsed.chips)) {
    throw new Error("Claude's response was valid JSON but not in the expected shape.");
  }
  parsed.skip = !!parsed.skip;
  return parsed;
}

// ---- Bloom Together: friend streaks + encouragement ------------------------------------
// Deliberately minimal and low-risk for a minors-facing social feature:
//   - No real names/accounts — just a self-chosen nickname, matching the rest of the app.
//   - No freeform messages between users. Encouragement is always ONE of a fixed, curated
//     set of supportive phrases — never arbitrary text — because freeform messaging between
//     minors is a real harassment vector that the Talk-to-Bloom guardrails don't cover at
//     all (those guardrails only apply to the user-to-AI conversation).
//   - This server never receives pillar scores for this feature — only check-in *dates* — so
//     it's structurally impossible for one friend to see another's actual energy/stress/
//     sleep/motivation numbers, not just a UI choice.
// Persisted to a JSON file rather than kept purely in memory: Render's free tier spins the
// process down after ~15 minutes idle, and pure in-memory state would be wiped on nearly
// every wake-up. A file survives that (though not necessarily a fresh redeploy, depending on
// Render's disk behavior). This is a fine MVP store for a friend group testing it — swap for
// a real hosted database before this needs to support more than that.
const SOCIAL_FILE = path.join(__dirname, "social-data.json");
function loadSocial() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SOCIAL_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.members) return parsed;
  } catch (e) { /* file missing or corrupt — start fresh */ }
  return { members: {} }; // members: { id: { nickname, inviteCode, checkins: [dateKey,...], friends: [id,...], inbox: [{from,phrase,ts}] } }
}
function saveSocial() {
  try { fs.writeFileSync(SOCIAL_FILE, JSON.stringify(social)); }
  catch (e) { console.error("Failed to save social-data.json:", e.message); }
}
let social = loadSocial();

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous-looking characters
function randomCode(len) {
  let out = "";
  for (let i = 0; i < len; i++) out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return out;
}
function findMemberByInviteCode(code) {
  return Object.keys(social.members).find((id) => social.members[id].inviteCode === code) || null;
}

const ENCOURAGEMENT_PHRASES = [
  "Proud of you for showing up today.",
  "You've got this, one day at a time.",
  "Just checking in to say I'm rooting for you.",
  "Rest is part of the work too — you're doing fine.",
  "Keep going, your consistency is paying off.",
  "Sending you good energy for today.",
  "You don't have to be perfect, just present.",
  "Thinking of you, hope today feels a little lighter.",
  "Locked in together. Let's keep it going.",
  "No pressure, just a reminder that you're not doing this alone.",
];

function parseDateKey(k) {
  const parts = String(k).split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return null;
  // The client sends "YYYY-M-D" with a 1-indexed month (JS getMonth()+1) — Date.UTC wants
  // 0-indexed, so subtract 1 here or every date after a month boundary parses one day off.
  return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12)); // noon UTC sidesteps DST edge cases
}
// Longest run of consecutive calendar days (most recent first) where BOTH members logged a
// check-in — mirrors the personal streak's "miss a day and it resets" logic, but as its own
// separate, opt-in social number. A missed day here never touches either person's own Buddy
// evolution or personal streak, which are computed entirely independently of this file.
function mutualStreak(memberA, memberB) {
  if (!memberA || !memberB) return 0;
  const setB = new Set(memberB.checkins || []);
  const shared = (memberA.checkins || [])
    .filter((k) => setB.has(k))
    .map(parseDateKey)
    .filter(Boolean)
    .sort((a, b) => b - a);
  if (!shared.length) return 0;
  const now = new Date();
  now.setUTCHours(12, 0, 0, 0);
  const oneDay = 86400000;
  if (Math.abs(now - shared[0]) > oneDay * 1.5) return 0; // most recent shared day isn't today/yesterday — streak's gone cold
  let streak = 1;
  for (let i = 1; i < shared.length; i++) {
    if (Math.abs(shared[i - 1] - shared[i] - oneDay) < 3600000) streak++;
    else break;
  }
  return streak;
}
function publicMember(id) {
  const m = social.members[id];
  if (!m) return null;
  const friends = (m.friends || []).map((fid) => {
    const f = social.members[fid];
    if (!f) return null;
    return { id: fid, nickname: f.nickname, streak: mutualStreak(m, f) };
  }).filter(Boolean);
  return { id, nickname: m.nickname, inviteCode: m.inviteCode, friends, inbox: (m.inbox || []).slice(-15).reverse() };
}

function send(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, hasKey: !!API_KEY, model: MODEL });
    return;
  }

  if (req.method === "POST" && req.url === "/api/insights") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (e) {
        send(res, 400, { error: "Invalid JSON body." });
        return;
      }
      if (!Array.isArray(payload.history)) {
        send(res, 400, { error: "Missing 'history' array in request body." });
        return;
      }
      try {
        const result = await callClaude(payload);
        send(res, 200, result);
      } catch (e) {
        console.error(e);
        send(res, e.code === "NO_KEY" ? 500 : 502, { error: e.message, code: e.code || "UNKNOWN" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/followup") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (e) {
        send(res, 400, { error: "Invalid JSON body." });
        return;
      }
      if (!payload.pillar || !payload.label || typeof payload.value !== "number") {
        send(res, 400, { error: "Missing 'pillar', 'label', or numeric 'value' in request body." });
        return;
      }
      try {
        const result = await callFollowup(payload);
        send(res, 200, result);
      } catch (e) {
        console.error(e);
        send(res, e.code === "NO_KEY" ? 500 : 502, { error: e.message, code: e.code || "UNKNOWN" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/talk") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let payload;
      try {
        payload = JSON.parse(body || "{}");
      } catch (e) {
        send(res, 400, { error: "Invalid JSON body." });
        return;
      }
      if (typeof payload.message !== "string" || !payload.message.trim()) {
        send(res, 400, { error: "Missing non-empty 'message' string in request body." });
        return;
      }
      try {
        const result = await callTalk(payload);
        send(res, 200, result);
      } catch (e) {
        console.error(e);
        send(res, e.code === "NO_KEY" ? 500 : 502, { error: e.message, code: e.code || "UNKNOWN" });
      }
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/social/register") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch (e) { send(res, 400, { error: "Invalid JSON body." }); return; }
      const nickname = (payload.nickname || "").toString().trim().slice(0, 20);
      if (!nickname) { send(res, 400, { error: "Missing non-empty 'nickname'." }); return; }
      let id;
      do { id = randomCode(8); } while (social.members[id]);
      let inviteCode;
      do { inviteCode = randomCode(6); } while (findMemberByInviteCode(inviteCode));
      social.members[id] = { nickname, inviteCode, checkins: [], friends: [], inbox: [] };
      saveSocial();
      send(res, 200, publicMember(id));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/social/connect") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch (e) { send(res, 400, { error: "Invalid JSON body." }); return; }
      const memberId = payload.memberId, inviteCode = (payload.inviteCode || "").toString().trim().toUpperCase();
      if (!social.members[memberId]) { send(res, 404, { error: "Unknown memberId." }); return; }
      const friendId = findMemberByInviteCode(inviteCode);
      if (!friendId) { send(res, 404, { error: "No one has that invite code." }); return; }
      if (friendId === memberId) { send(res, 400, { error: "That's your own invite code." }); return; }
      const me = social.members[memberId], friend = social.members[friendId];
      if (me.friends.indexOf(friendId) === -1) me.friends.push(friendId);
      if (friend.friends.indexOf(memberId) === -1) friend.friends.push(memberId);
      saveSocial();
      send(res, 200, publicMember(memberId));
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/social/checkin") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch (e) { send(res, 400, { error: "Invalid JSON body." }); return; }
      const member = social.members[payload.memberId];
      if (!member) { send(res, 404, { error: "Unknown memberId." }); return; }
      const dateKey = (payload.dateKey || "").toString();
      if (!parseDateKey(dateKey)) { send(res, 400, { error: "Missing/invalid 'dateKey' (expected YYYY-M-D)." }); return; }
      if (member.checkins.indexOf(dateKey) === -1) member.checkins.push(dateKey);
      saveSocial();
      send(res, 200, { ok: true });
    });
    return;
  }

  if (req.method === "GET" && req.url.indexOf("/api/social/state") === 0) {
    const memberId = new URL(req.url, "http://x").searchParams.get("memberId");
    const view = publicMember(memberId);
    if (!view) { send(res, 404, { error: "Unknown memberId." }); return; }
    send(res, 200, view);
    return;
  }

  if (req.method === "POST" && req.url === "/api/social/encourage") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch (e) { send(res, 400, { error: "Invalid JSON body." }); return; }
      const from = social.members[payload.fromId], to = social.members[payload.toId];
      if (!from || !to) { send(res, 404, { error: "Unknown memberId." }); return; }
      if (from.friends.indexOf(payload.toId) === -1) { send(res, 400, { error: "You can only encourage a friend." }); return; }
      const phrase = ENCOURAGEMENT_PHRASES[Math.floor(Math.random() * ENCOURAGEMENT_PHRASES.length)];
      to.inbox.push({ from: from.nickname, phrase: phrase, ts: Date.now() });
      to.inbox = to.inbox.slice(-20);
      saveSocial();
      send(res, 200, { phrase: phrase });
    });
    return;
  }

  send(res, 404, { error: "Not found. Try GET /health, POST /api/insights, POST /api/followup, POST /api/talk, or the /api/social/* endpoints." });
});

server.listen(PORT, () => {
  console.log(`Bloom AI Insights backend listening on http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  API key configured: ${!!API_KEY}`);
  console.log(`  Try: curl http://localhost:${PORT}/health`);
  console.log(`  Endpoints: POST /api/insights, POST /api/followup, POST /api/talk, POST /api/social/register, POST /api/social/connect, POST /api/social/checkin, GET /api/social/state, POST /api/social/encourage`);
});
