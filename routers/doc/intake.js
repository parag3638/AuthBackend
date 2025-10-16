const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const { z } = require("zod");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const { randomUUID } = require("crypto");
const upload = multer({ storage: multer.memoryStorage() });
const OpenAI = require("openai");


const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});


// simple rate limit (tune later)
const sseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 requests/min per IP
});


router.post("/agent-turn", sseLimiter, async (req, res) => {
  try {
    const { history = [], user_message } = req.body || {};
    if (!user_message || typeof user_message !== "string") {
      return res.status(400).json({ error: "user_message is required" });
    }

    // SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const sysPrompt = [
      "You are an empathetic clinical intake nurse.",
      "Goal: gather symptoms, onset/duration, severity (0–10), triggers/relievers,",
      "associated symptoms, meds, allergies, key risk factors.",
      "Rules: Ask ONE concise, focused question at a time.",
      "Avoid diagnosis or treatment. Be warm and brief."
    ].join(" ");

    // build messages
    const messages = [
      { role: "system", content: sysPrompt },
      ...history.map((t) => ({
        role: t.role === "patient" ? "user" : "assistant",
        content: String(t.content || "").slice(0, 2000),
      })),
      { role: "user", content: user_message.slice(0, 2000) },
    ];

    // call OpenAI (Node 18+ has global fetch)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",     // pick a fast+cheap model
        stream: true,
        temperature: 0.3,
        messages,
      }),
    });

    if (!resp.ok || !resp.body) {
      const text = await resp.text().catch(() => "");
      res.write(`event: error\ndata: ${JSON.stringify({ error: text || resp.statusText })}\n\n`);
      res.end();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    const send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // OpenAI streams as "data: ..." lines with [DONE]
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });

      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          send("done", {});
          res.end();
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content || "";
          if (delta) send("token", { text: delta });
        } catch {
          // ignore keepalives
        }
      }
    }

    // safety end
    send("done", {});
    res.end();
  } catch (err) {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message || "error" })}\n\n`);
      res.end();
    } catch { }
  }
});

//--------------------------------------------------------------------------------------------
// Submit endpoint
//------------------------------------------------------------------------------


const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,   // keep server-only
  { auth: { persistSession: false } }
);

// Basic limiter for submit
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
});

// Zod validation (JS friendly)
const Turn = z.object({
  role: z.enum(["patient", "agent"]),
  content: z.string().min(1),
  created_at: z.string().optional(), // ISO timestamp if provided
});

const Doc = z.object({
  file_name: z.string().min(1),
  mime_type: z.string().min(1),
  storage_path: z.string().min(1),   // e.g., intake-docs/{sessionId}/{uuid}.pdf
});

const Summary = z.object({
  soap: z.any(),                     // keep flexible for now
  ddx: z.array(z.any()),
  icd10_codes: z.array(z.string()),
  red_flags: z.array(z.any())
}).passthrough();


const SubmitBody = z.object({
  // NOTE: your DB function always writes 'submitted', so 'status' is ignored here.
  session_id: z.string().uuid().optional(),
  patient_name: z.string().min(1),
  patient_dob: z.string().optional(),      // "YYYY-MM-DD" or omit
  patient_phone: z.string().min(5).optional(),
  patient_email: z.string().email().optional(),
  transcript: z.array(Turn).min(1),
  documents: z.array(Doc).default([]),
  // summary: Summary,
  summary: Summary.optional().default({})   // allow missing summary entirely
});

// Helper: safe JSON parse for multipart fields
function parseJSONField(str, fallback) {
  if (typeof str !== "string") return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

// Utility: is the summary effectively empty?
function isEmptySummary(s) {
  if (!s || typeof s !== "object") return true;
  const hasSoap =
    s.soap &&
    (Boolean(s.soap.subjective?.trim?.()) || Boolean(s.soap.objective?.trim?.()));
  const hasDdx = Array.isArray(s.ddx) && s.ddx.length > 0;
  const hasIcd = Array.isArray(s.icd10_codes) && s.icd10_codes.length > 0;
  const hasFlags = Array.isArray(s.red_flags) && s.red_flags.length > 0;
  return !(hasSoap || hasDdx || hasIcd || hasFlags);
}

// Fallback if AI fails
function rulesFallback(transcript) {
  const text = (transcript || []).map(m => `${m.role}: ${m.content}`).join("\n");
  const match = /patient:\s*(.+)/i.exec(text);
  const subj = (match ? match[1] : "").slice(0, 200) || "Patient-reported concerns.";
  return {
    soap: { subjective: subj, objective: "N/A" },
    ddx: ["Viral syndrome"],
    icd10_codes: ["R69"], // Illness, unspecified
    red_flags: [],
  };
}

// Core AI generator — returns strict JSON
async function generateSummaryAI({ transcript, patient }) {
  const system = `
        You are a clinical summarization assistant.

        Return STRICT JSON ONLY matching this exact structure (no prose, no extra keys):
        {
          "soap": {
            "subjective": string,                                  // 1–3 sentences from patient history
            "objective": string,                                   // measurements/exam/tests; if none, "N/A"
            "assessment": [                                        // array of concise impressions
              { "condition": string, "rationale"?: string }
            ],
            "plan": string[]                                       // short steps; each item a brief phrase
          },
          "ddx": [                                                 // Differential Dx (2–4 items), sorted most→least likely
            {
              "condition": string,
              "likelihood"?: number,                               // 0–1 float (e.g., 0.6). Omit if truly uncertain.
              "rationale"?: string                                 // brief evidence from transcript; omit if none
            }
          ],
          "icd10_codes": string[],                                 // 1–3 plausible codes; prefer specific if supported
          "red_flags": [                                           // explicit red-flag features; [] if none
            { "flag": string, "reason"?: string }
          ]
        }

        Rules:
        - Output ONLY a valid JSON object conforming to the structure above.
        - Be conservative and evidence-based; never invent vitals/tests. If none present, "objective" = "N/A".
        - Subjective (S): chief complaint, onset/duration, modifiers from patient messages.
        - Objective (O): observed/measured data only; avoid fabrication.
        - Assessment (A): 1–3 concise impressions tying S/O; each as {condition, rationale?}.
        - Plan (P): 2–5 brief actions (e.g., "rest and fluids"; "acetaminophen"; "return if chest pain worsens"; "follow-up 48h").
        - Differential Dx:
          - Provide 2–4 items.
          - Sort by most likely first.
          - "likelihood" is a float between 0 and 1 (e.g., 0.7). Include when you have any comparative basis; otherwise omit.
          - "rationale" should cite transcript clues succinctly (e.g., "exertional chest pain; no fever").
          - Do NOT return ["none"] or ["N/A"]; use at least two reasonable candidates when possible.
        - ICD-10:
          - Provide at least 1 and at most 3 codes.
          - Prefer specific codes when justified; otherwise use safe unspecified (e.g., R07.9 for unspecified chest pain).
        - Red Flags:
          - Return an array of objects: { "flag": string, "reason"?: string }.
          - Include only clearly present or reasonably implied red-flag features.
          - If none, return an empty array [] (not "none" or "N/A").
        - Keep language clinical and concise. No disclaimers, no extra commentary.

        Your output MUST be valid JSON and adhere exactly to the schema above. `;

  const user = JSON.stringify({ patient, transcript }, null, 2);

  try {
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content:
            "Given this patient context and transcript, produce the JSON. " +
            "Again, output ONLY the JSON object, no markdown.\n\n" +
            user,
        },
      ],
      response_format: { type: "json_object" },
    });

    const content = resp.choices?.[0]?.message?.content?.trim() || "";
    const parsed = JSON.parse(content);

    if (!parsed.soap || !("subjective" in parsed.soap) || !("objective" in parsed.soap)) {
      throw new Error("Invalid JSON structure from model");
    }
    parsed.ddx = Array.isArray(parsed.ddx) ? parsed.ddx.filter(Boolean) : [];
    parsed.icd10_codes = Array.isArray(parsed.icd10_codes) ? parsed.icd10_codes.filter(Boolean) : [];
    parsed.red_flags = Array.isArray(parsed.red_flags) ? parsed.red_flags.filter(Boolean) : [];

    return parsed;
  } catch (e) {
    console.warn("AI summary generation failed, using fallback:", e.message || e);
    return rulesFallback(transcript);
  }
}

router.post("/submit", submitLimiter, upload.any(), async (req, res) => {
  try {
    // 1) accept JSON or multipart with a "payload" field
    const isMultipart = req.is("multipart/form-data");
    const raw = isMultipart ? parseJSONField((req.body || {}).payload, null) : req.body;

    if (!raw) {
      return res.status(400).json({ ok: false, error: "Missing or invalid payload." });
    }

    // 2) stable session id (also used in storage paths)
    const sessionId = raw.session_id || randomUUID();

    // 3) handle uploads (if multipart)
    let docs = Array.isArray(raw.documents) ? raw.documents : [];
    if (isMultipart && Array.isArray(req.files) && req.files.length > 0) {
      const uploadedDocs = [];

      for (const f of req.files) {
        const fileExt = (f.originalname && f.originalname.includes(".")) ? f.originalname.split(".").pop() : "bin";
        const fileId = randomUUID().replace(/-/g, "");
        const storage_path = `intake-docs/${sessionId}/${fileId}.${fileExt}`;

        const { error: upErr } = await sb.storage
          .from("intake-docs")
          .upload(storage_path, f.buffer, {
            contentType: f.mimetype || "application/octet-stream",
            upsert: true,
          });

        if (upErr) {
          console.error("Supabase upload error:", upErr);
          return res.status(500).json({ ok: false, error: upErr.message });
        }

        uploadedDocs.push({
          file_name: f.originalname || "upload.bin",
          mime_type: f.mimetype || "application/octet-stream",
          storage_path,
        });
      }

      docs = docs.concat(uploadedDocs);
    }

    // 4) validate against Zod
    const toValidate = {
      session_id: sessionId,
      patient_name: raw.patient_name,
      patient_dob: raw.patient_dob,
      patient_phone: raw.patient_phone,
      patient_email: raw.patient_email,
      transcript: raw.transcript,
      documents: docs,
      summary: raw.summary ?? {},
    };

    const parsed = SubmitBody.safeParse(toValidate);
    if (!parsed.success) {
      const flat = parsed.error.flatten();
      console.warn("Invalid submit body:", flat);
      return res.status(400).json({ ok: false, error: flat });
    }

    const {
      patient_name, patient_dob, patient_phone, patient_email,
      transcript, documents
    } = parsed.data;


    let summary = parsed.data.summary;
    if (isEmptySummary(summary)) {
      summary = await generateSummaryAI({
        transcript,
        patient: {
          name: patient_name,
          dob: patient_dob,
          phone: patient_phone,
          email: patient_email,
        },
      });
    }


    // 5) call your 7-arg RPC that writes sessions + messages + docs + summary
    const { data, error } = await sb.rpc("submit_intake_tx", {
      p_patient_name: patient_name,
      p_patient_dob: patient_dob || null,
      p_patient_phone: patient_phone || "N/A",
      p_patient_email: patient_email || "N/A",
      p_transcript: transcript,
      p_documents: documents,
      p_summary: summary,
    });

    if (error) {
      console.error("submit_intake_tx error:", error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    const finalSessionId = data || sessionId;
    return res.json({ ok: true, sessionId: finalSessionId });
  } catch (e) {
    console.error("submit error", e);
    return res.status(500).json({ ok: false, error: e && e.message ? e.message : "Server error" });
  }
});

module.exports = router;