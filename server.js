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

const SYSTEM_PROMPT = `You are a data analyst for Bloom, a teen athlete wellbeing check-in app grounded in athlete-burnout research (the Athlete Burnout Questionnaire's exhaustion / reduced-accomplishment / devaluation dimensions, plus sleep and perceived stress-recovery balance from adolescent-athlete studies).

You will be given a user's daily check-in scores (0-100) across 4 pillars — Energy, Stress Balance, Sleep, Motivation — for the last 14 days, plus their current check-in streak.

Write:
1) A short list of specific, evidence-based alerts about patterns worth the user's attention.
2) One short paragraph summarizing their overall wellbeing trend over the period.

Rules:
- Ground every statement in the actual numbers you're given. Never invent data, never make up a number that isn't derivable from the input.
- Do not diagnose, use clinical/medical language, or claim to detect a disorder. You are surfacing patterns, not making a diagnosis.
- Tone: direct, specific, and grounded. Never generic motivational quotes ("you've got this!"), never preachy, never repeat the same phrasing across alerts.
- Only if scores show a genuinely concerning pattern (a large multi-day drop, or a sustained decline across 2+ pillars) may you gently suggest talking to a coach, parent, or trusted adult — and only once, not in every alert. Do not do this by default.
- Keep it teen-appropriate, non-alarmist, and never longer than necessary.
- Output ONLY valid JSON matching this exact shape — nothing else, no markdown code fences, no commentary before or after:
{"alerts":[{"icon":"<single emoji>","severity":"good"|"warn","text":"<one sentence, specific, under 160 characters>"}],"narrative":"<2-4 sentences of plain text, may reference specific numbers>"}
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

  send(res, 404, { error: "Not found. Try GET /health, POST /api/insights, or POST /api/followup." });
});

server.listen(PORT, () => {
  console.log(`Bloom AI Insights backend listening on http://localhost:${PORT}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  API key configured: ${!!API_KEY}`);
  console.log(`  Try: curl http://localhost:${PORT}/health`);
  console.log(`  Endpoints: POST /api/insights, POST /api/followup`);
});
