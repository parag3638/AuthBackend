const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");
const { z } = require("zod");


const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,   // keep server-only
  { auth: { persistSession: false } }
);


// --------------------------------------------------------------------------------------------
// Doctor inbox endpoint
// --------------------------------------------------------------------------------------------

router.get("/inbox", async (req, res) => {
  try {
    const {
      status,
      q,
      page = "1",
      pageSize = "20",
      sortBy = "submitted_at",
      sortDir = "desc",
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
    const from = (pageNum - 1) * sizeNum;
    const to = from + sizeNum - 1;

    // Validate sort keys
    const sortable = new Set(["submitted_at", "status", "patient_name"]);
    const sortKey = sortable.has(String(sortBy)) ? String(sortBy) : "submitted_at";
    const sortAsc = String(sortDir).toLowerCase() === "asc";

    // Base query
    let query = sb
      .from("intake_sessions")
      .select(
        `
        id, status, submitted_at, updated_at,
        patient_name, patient_phone,
        documents ( id ),
        clinical_summaries ( soap, ddx, red_flags )
      `,
        { count: "exact" }
      );

    if (["pending", "closed", "reviewed"].includes(String(status))) {
      query = query.eq("status", String(status));
    }

    // simple "q" search on a few text columns
    if (q && typeof q === "string" && q.trim() !== "") {
      const term = q.trim();
      query = query.or(
        `patient_name.ilike.%${term}%,patient_phone.ilike.%${term}%,patient_email.ilike.%${term}%`
      );
    }

    // sorting + pagination
    query = query.order(sortKey, { ascending: sortAsc }).range(from, to);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows =
      (data || []).map((s) => ({
        id: s.id,
        patient_name: s.patient_name || "Anonymous",
        complaint: s.clinical_summaries?.soap?.subjective?.slice(0, 80) || "—",
        probable_dx: s.clinical_summaries?.ddx?.[0]?.condition || "—",
        files_count: s.documents?.length || 0,
        red_flags_count: s.clinical_summaries?.red_flags?.length || 0,
        status: s.status,
        updated_at: s.updated_at,


        submitted_at: s.submitted_at,
        patient_phone: s.patient_phone,
      })) ?? [];


    // const rows =
    //   (data || []).map((s) => ({
    //     id: s.id,
    //     status: s.status,
    //     submitted_at: s.submitted_at,
    //     patient_name: s.patient_name,
    //     patient_phone: s.patient_phone,
    //     files_count: Array.isArray(s.documents) ? s.documents.length : 0,
    //     red_flags_count: Array.isArray(s.clinical_summaries?.red_flags)
    //       ? s.clinical_summaries.red_flags.length
    //       : 0,
    //   })) ?? [];

    res.json({
      rows,
      meta: {
        total: count ?? 0,
        page: pageNum,
        pageSize: sizeNum,
        sortBy: sortKey,
        sortDir: sortAsc ? "asc" : "desc",
      },
    });
  } catch (e) {
    console.error("inbox error", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});


// tiny CSV helper (handles quotes/newlines)
function toCSV(rows) {
  if (!rows?.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ];
  return lines.join("\n");
}

// Download as CSV
router.get("/inbox.csv", async (req, res) => {
  try {
    const {
      status,
      q,
      page = "1",
      pageSize = "1000",
      sortBy = "submitted_at",
      sortDir = "desc",
    } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const sizeNum = Math.min(Math.max(parseInt(pageSize, 10) || 1000, 1), 5000);
    const from = (pageNum - 1) * sizeNum;
    const to = from + sizeNum - 1;

    const sortable = new Set(["submitted_at", "status", "patient_name"]);
    const sortKey = sortable.has(String(sortBy)) ? String(sortBy) : "submitted_at";
    const sortAsc = String(sortDir).toLowerCase() === "asc";

    let query = sb
      .from("intake_sessions")
      .select(
        `
        id, status, submitted_at, updated_at,
        patient_name, patient_phone, patient_email,
        documents ( id ),
        clinical_summaries ( soap, ddx, red_flags )
      `
      );

    if (["pending", "closed", "reviewed"].includes(String(status))) {
      query = query.eq("status", String(status));
    }

    if (q && typeof q === "string" && q.trim() !== "") {
      const term = q.trim();
      query = query.or(
        `patient_name.ilike.%${term}%,patient_phone.ilike.%${term}%,patient_email.ilike.%${term}%`
      );
    }

    query = query.order(sortKey, { ascending: sortAsc }).range(from, to);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });

    const rows = (data || []).map((s) => ({
      id: s.id,
      patient_name: s.patient_name || "Anonymous",
      patient_phone: s.patient_phone || "",
      patient_email: s.patient_email || "",
      complaint: s.clinical_summaries?.soap?.subjective?.slice(0, 80) || "",
      probable_dx:
        Array.isArray(s.clinical_summaries?.ddx) && s.clinical_summaries.ddx.length
          ? s.clinical_summaries.ddx[0]?.condition || ""
          : "",
      files_count: Array.isArray(s.documents) ? s.documents.length : 0,
      red_flags_count: Array.isArray(s.clinical_summaries?.red_flags)
        ? s.clinical_summaries.red_flags.length
        : 0,
      status: s.status,
      submitted_at: s.submitted_at,
      updated_at: s.updated_at,
    }));

    const csv = toCSV(rows);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="inbox-export.csv"');
    return res.status(200).send(csv);
  } catch (e) {
    console.error("inbox.csv error", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});


// Dashboard
router.get("/dashboard", async (req, res) => {
  try {
    const { data: sessions, error } = await sb
      .from("intake_sessions")
      .select(`
        id,
        status,
        submitted_at,
        closed_at,
        patient_dob,
        updated_at,
        patient_name,
        clinical_summaries ( ddx, red_flags, updated_at )
      `)
      .order("submitted_at", { ascending: true });

    if (error) throw error;
    if (!sessions?.length) return res.json({ kpis: {}, charts: {} });

    // ---------- KPIs ----------
    const totalCases = sessions.length;
    const pendingCases = sessions.filter((s) => s.status === "pending").length;
    const closedCases = sessions.filter((s) => s.status === "closed").length;
    const reviewedCases = sessions.filter((s) => s.status === "reviewed").length;

    // Average time to resolution (closed sessions)
    const closedWithTime = sessions
      .filter((s) => s.closed_at)
      .map(
        (s) =>
          (new Date(s.closed_at) - new Date(s.submitted_at)) /
          (1000 * 60 * 60 * 24)
      ); // days
    const avgResolutionTime =
      closedWithTime.length > 0
        ? closedWithTime.reduce((a, b) => a + b, 0) / closedWithTime.length
        : 0;

    // Average patient age
    const today = new Date();
    const ages = sessions
      .map((s) => {
        const dob = new Date(s.patient_dob);
        if (!isNaN(dob)) return today.getFullYear() - dob.getFullYear();
        return null;
      })
      .filter(Boolean);
    const avgAge =
      ages.length > 0 ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : 0;

    // ---------- Time-series (Line Chart) ----------
    const dailyCounts = {};
    for (const s of sessions) {
      const d = new Date(s.submitted_at).toISOString().split("T")[0];
      dailyCounts[d] = (dailyCounts[d] || 0) + 1;
    }
    const lineChart = Object.entries(dailyCounts).map(([date, count]) => ({
      date,
      count,
    }));

    // ---------- Bar Chart (Age distribution) ----------
    const buckets = { "0-20": 0, "21-40": 0, "41-60": 0, "60+": 0 };
    for (const a of ages) {
      if (a <= 20) buckets["0-20"]++;
      else if (a <= 40) buckets["21-40"]++;
      else if (a <= 60) buckets["41-60"]++;
      else buckets["60+"]++;
    }
    const barChart = Object.entries(buckets).map(([range, count]) => ({
      range,
      count,
    }));

    // ---------- Pie Chart (Status distribution) ----------
    const pieChart = [
      { status: "pending", count: pendingCases },
      { status: "closed", count: closedCases },
      { status: "reviewed", count: reviewedCases },
    ];

    // ---------- Table (recently updated intake sessions) ----------
    // Columns: Patient | DDx | Red Flags | Status | Updated
    const safeArr = (x) => (Array.isArray(x) ? x : []);
    const ddxLabels = (ddx) =>
      safeArr(ddx)
        .map((d) => d?.condition)
        .filter(Boolean);

    const redFlagLabels = (rf) =>
      safeArr(rf)
        .map((r) => r?.flag)
        .filter(Boolean);

    const pickUpdatedAt = (s) =>
      s?.clinical_summaries?.updated_at || s?.updated_at || s?.submitted_at;

    const tableRows = sessions
      .sort((a, b) => new Date(pickUpdatedAt(b)) - new Date(pickUpdatedAt(a)))
      .slice(0, 5)
      .map((s) => {
        const ddx = ddxLabels(s?.clinical_summaries?.ddx);
        const rf = redFlagLabels(s?.clinical_summaries?.red_flags);

        // compact display: show up to 3 items  overflow counter
        const ddxDisplay = ddx.slice(0, 3);
        const ddxOverflow = Math.max(ddx.length - ddxDisplay.length, 0);
        const rfDisplay = rf.slice(0, 2);
        const rfOverflow = Math.max(rf.length - rfDisplay.length, 0);

        return {
          id: s.id,
          patient: s.patient_name || "Anonymous",
          ddx: ddxDisplay,                // array; front-end can render badges
          ddx_overflow: ddxOverflow,      // number; render as "N" badge
          red_flags: rfDisplay,           // array; front-end can render badges
          red_flags_overflow: rfOverflow, // number; render as "N"
          status: s.status,
          updated: pickUpdatedAt(s),
        };
      });

    // ---------- Stacked Bar Chart: Conditions by Category ----------
    const mode = ("unique").toLowerCase(); // "unique" | "codes"
    // const toPercent = String(req.query.percent || "false") === "true"; // return 100% stacked
    const toPercent = String("false") === "true"; // return 100% stacked

    const { data: summaries, error: summaryErr } = await sb
      .from("clinical_summaries")
      .select("created_at, icd10_codes");  // icd10_codes stored as JSON text
    if (summaryErr) throw summaryErr;

    // Map ICD-10 first letter → high-level category (extend as needed)
    const icdCat = (code) => {
      const p = String(code || "").trim().charAt(0).toUpperCase();
      if (p === "A" || p === "B") return "Infectious";
      if (p === "C" || p === "D") return "Neoplasms";                  // C00-D49
      if (p === "E") return "Endocrine/Metabolic";
      if (p === "F") return "Mental/Behavioral";
      if (p === "G") return "Nervous System";
      if (p === "H") return "Eye/Ear";
      if (p === "I") return "Circulatory";
      if (p === "J") return "Respiratory";
      if (p === "K") return "Digestive";
      if (p === "L") return "Skin";
      if (p === "M") return "Musculoskeletal";
      if (p === "N") return "Genitourinary";
      if (p === "O") return "Pregnancy/Childbirth";
      if (p === "P") return "Perinatal";
      if (p === "Q") return "Congenital";
      if (p === "R") return "Symptoms/Signs";
      if (p === "S" || p === "T") return "Injury/Poisoning";
      if (p === "V" || p === "W" || p === "X" || p === "Y") return "External Causes";
      if (p === "Z") return "Factors Influencing Health";
      return "Other";
    };

    // Aggregate across ALL summaries as one snapshot bar (since you said only one bar for now)
    const counts = {};   // { category: number }
    let totalUnits = 0;  // denominator for percent mode

    for (const row of summaries || []) {
      let codes = [];
      // try { codes = JSON.parse(row.icd10_codes || "[]"); } catch { }
      try { codes = (row.icd10_codes || "[]"); } catch { }
      if (!Array.isArray(codes) || codes.length === 0) continue;

      if (mode === "unique") {
        // Count each category at most once per summary
        const cats = new Set(codes.map(icdCat));
        cats.forEach((c) => {
          counts[c] = (counts[c] || 0) + 1;
        });
        totalUnits += 1; // one unit per summary
      } else {
        // mode === "codes" → count every code
        codes.forEach((code) => {
          const c = icdCat(code);
          counts[c] = (counts[c] || 0) + 1;
          totalUnits += 1; // one unit per code
        });
      }
    }

    // Optionally convert to percentages for 100% stacked display
    let stackedBar = [{
      label: "Diagnosis Mix",
      ...(
        toPercent && totalUnits > 0
          ? Object.fromEntries(
            Object.entries(counts).map(([k, v]) => [k, Number(((v / totalUnits) * 100).toFixed(1))])
          )
          : counts
      )
    }];

    // Ensure stable key order for frontend (optional)
    stackedBar = stackedBar.map(obj => {
      const order = [
        "Neoplasms", "Endocrine/Metabolic", "Musculoskeletal", "Symptoms/Signs",
        "Circulatory", "Respiratory", "Digestive", "Genitourinary",
        "Infectious", "Nervous System", "Eye/Ear", "Skin",
        "Pregnancy/Childbirth", "Perinatal", "Congenital",
        "Injury/Poisoning", "External Causes", "Factors Influencing Health", "Other"
      ];
      const out = { label: obj.label };
      for (const k of order) if (obj[k] != null) out[k] = obj[k];
      // include any unexpected keys
      for (const [k, v] of Object.entries(obj)) if (!(k in out)) out[k] = v;
      return out;
    });


    res.json({
      kpis: {
        totalCases,
        pendingCases,
        closedCases,
        reviewedCases,
        avgResolutionTime: Number(avgResolutionTime.toFixed(2)),
        avgAge,
      },
      charts: {
        lineChart,
        barChart,
        pieChart,
        // stackedChart,
        stackedChart: stackedBar,
      },
      table: tableRows,
    });
  } catch (e) {
    console.error("dashboard error", e);
    res.status(500).json({ error: e.message || "Server error" });
  }
});

// GET /doctor/intake/:id  -> detail view
router.get("/intake/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // (optional) quick UUID sanity check
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    const { data, error } = await sb
      .from("intake_sessions")
      .select(`
        id, status, submitted_at, closed_at,
        patient_name, patient_dob, patient_phone, patient_email,
        intake_messages ( role, content, created_at ),
        documents ( id, file_name, mime_type, storage_path, created_at ),
        clinical_summaries ( soap, ddx, icd10_codes, red_flags, created_at, updated_at )
      `)
      .eq("id", id)
      .single();

    if (error) return res.status(404).json({ error: error.message });

    // Shape a clean response for the UI
    const session = {
      id: data.id,
      status: data.status,
      submitted_at: data.submitted_at,
      closed_at: data.closed_at,
      patient: {
        name: data.patient_name,
        dob: data.patient_dob,
        phone: data.patient_phone,
        email: data.patient_email,
      },
      transcript: (data.intake_messages || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      documents: (data.documents || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      summary: data.clinical_summaries
        ? {
          soap: data.clinical_summaries.soap,
          ddx: data.clinical_summaries.ddx,
          icd10_codes: data.clinical_summaries.icd10_codes,
          red_flags: data.clinical_summaries.red_flags,
          created_at: data.clinical_summaries.created_at,
          updated_at: data.clinical_summaries.updated_at,
        }
        : null,
    };

    return res.json({ session });
  } catch (e) {
    console.error("doctor/detail error", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

router.post("/intake/:id/close", async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }
    const { error } = await sb
      .from("intake_sessions")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    console.error("doctor/close error", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});

// POST /doctor/intake/:id/review
router.post("/intake/:id/review", async (req, res) => {
  try {
    const { id } = req.params;

    // quick UUID sanity check
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) {
      return res.status(400).json({ error: "Invalid id" });
    }

    // Fetch current status to validate transition
    const { data: row, error: fetchErr } = await sb
      .from("intake_sessions")
      .select("id, status")
      .eq("id", id)
      .single();

    if (fetchErr || !row) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (row.status === "closed") {
      // disallow moving a closed case to reviewed
      return res.status(409).json({ error: "Closed cases cannot be reviewed" });
    }

    if (row.status === "reviewed") {
      // already reviewed → idempotent success
      return res.json({ ok: true });
    }

    if (row.status !== "pending") {
      // only pending → reviewed allowed here
      return res.status(409).json({ error: `Invalid transition from ${row.status} to reviewed` });
    }

    // Race-safe update: only update if it's still pending
    const { error: updErr } = await sb
      .from("intake_sessions")
      .update({
        status: "reviewed",
        // updated_at: new Date().toISOString(), // uncomment if you have this column
      })
      .eq("id", id)
      .eq("status", "pending"); // guard against concurrent changes

    if (updErr) {
      return res.status(500).json({ error: updErr.message });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("doctor/review error", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});



// optional request body to tweak generation
const RegenBody = z.object({
  model: z.string().optional().default("gpt-4o-mini"),
  temperature: z.number().min(0).max(1).optional().default(0.2),
  include_ocr: z.boolean().optional().default(true)
});


router.post("/intake/:id/summary/regenerate", async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: "Invalid id" });
    const parsed = RegenBody.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    const { model, temperature, include_ocr } = parsed.data;

    // 1) pull transcript (+ optional OCR text)
    const { data: session, error } = await sb
      .from("intake_sessions")
      .select(`
        id, patient_name, patient_dob, patient_phone, patient_email,
        intake_messages ( role, content, created_at ),
        documents ( id ),
        clinical_summaries ( id )  -- to decide insert vs update
      `)
      .eq("id", id)
      .single();
    if (error) return res.status(404).json({ error: error.message });

    const messages = (session.intake_messages || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    // (optional) fetch OCR texts to enrich context
    let ocrBlob = "";
    if (include_ocr && session.documents?.length) {
      const docIds = session.documents.map(d => d.id);
      const { data: exts } = await sb
        .from("doc_extractions")
        .select("ocr_text, structured")
        .in("document_id", docIds);
      if (exts?.length) {
        const texts = exts.map(e => e?.ocr_text).filter(Boolean);
        if (texts.length) ocrBlob = texts.join("\n\n---\n\n");
      }
    }

    // 2) craft prompt
    const system = [
      "You are an empathetic clinical intake nurse.",
      "Using the conversation transcript (and OCR text if provided), produce a STRICT JSON object:",
      "{",
      '  "soap": { "subjective": string, "objective": string, "assessment": [{ "condition": string, "rationale": string }], "plan": string[] },',
      '  "ddx": [{ "condition": string, "likelihood": number, "rationale": string }],',
      '  "icd10_codes": string[],',
      '  "red_flags": [{ "flag": string, "reason": string }]',
      "}",
      "Rules: concise, evidence-based from patient statements; no treatment advice; only include ICD-10 codes you’re confident about.",
      "Return ONLY valid JSON. No extra text."
    ].join(" ");

    const convo = [
      { role: "system", content: system },
      {
        role: "user", content: `Patient (optional info): ${JSON.stringify({
          name: session.patient_name, dob: session.patient_dob, phone: session.patient_phone, email: session.patient_email
        })}`
      },
      { role: "user", content: "Transcript:\n" + messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n") }
    ];
    if (ocrBlob) {
      convo.push({ role: "user", content: "Supporting OCR text (may contain labs/reports):\n" + ocrBlob.slice(0, 12000) });
    }

    // 3) call LLM (single-shot, non-streaming)
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ model, temperature, messages: convo, stream: false })
    });
    const json = await resp.json();
    if (!resp.ok) return res.status(500).json({ error: json?.error?.message || "LLM error" });

    let output;
    try {
      // try direct JSON
      const text = json?.choices?.[0]?.message?.content || "{}";
      output = JSON.parse(text);
    } catch {
      // basic repair attempt: extract JSON block
      const text = json?.choices?.[0]?.message?.content || "{}";
      const match = text.match(/\{[\s\S]*\}$/);
      output = match ? JSON.parse(match[0]) : null;
    }
    if (!output) return res.status(500).json({ error: "Failed to parse model JSON" });

    // 4) upsert into clinical_summaries
    if (session.clinical_summaries?.id) {
      const { error: uErr } = await sb
        .from("clinical_summaries")
        .update({
          soap: output.soap,
          ddx: output.ddx,
          icd10_codes: output.icd10_codes,
          red_flags: output.red_flags,
          updated_at: new Date().toISOString()
        })
        .eq("session_id", id);
      if (uErr) return res.status(500).json({ error: uErr.message });
    } else {
      const { error: iErr } = await sb
        .from("clinical_summaries")
        .insert([{
          session_id: id,
          soap: output.soap,
          ddx: output.ddx,
          icd10_codes: output.icd10_codes,
          red_flags: output.red_flags
        }]);
      if (iErr) return res.status(500).json({ error: iErr.message });
    }

    return res.json({ ok: true, summary: output });
  } catch (e) {
    console.error("regenerate summary error", e);
    return res.status(500).json({ error: e?.message || "Server error" });
  }
});



// GET /doctor/intake/:id/documents/:docId/url
router.get("/intake/:id/documents/:docId/url", async (req, res) => {
  try {
    const { id, docId } = req.params;

    // Fetch document row (ensures this doc belongs to the session)
    const { data: doc, error } = await sb
      .from("documents")
      .select("id, storage_path, session_id")
      .eq("id", docId)
      .eq("session_id", id)
      .single();
    if (error || !doc) return res.status(404).json({ error: "Not found" });

    // Supabase Storage signed URL (adjust bucket name)
    const BUCKET = "intake-docs";
    const { data: signed, error: sErr } = await sb
      .storage
      .from(BUCKET)
      .createSignedUrl(doc.storage_path, 60 * 10); // 10 min
    if (sErr) return res.status(500).json({ error: sErr.message });

    return res.json({ url: signed.signedUrl });
  } catch (e) {
    console.error("doc url error", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});

// GET /doctor/intake/:id/export/json
router.get("/intake/:id/export/json", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await sb
      .from("intake_sessions")
      .select(`
        id, status, submitted_at, closed_at,
        patient_name, patient_dob, patient_phone, patient_email,
        intake_messages ( role, content, created_at ),
        clinical_summaries ( soap, ddx, icd10_codes, red_flags, updated_at, created_at )
      `)
      .eq("id", id).single();
    if (error) return res.status(404).json({ error: error.message });

    const payload = {
      id: data.id,
      status: data.status,
      submitted_at: data.submitted_at,
      closed_at: data.closed_at,
      patient: {
        name: data.patient_name,
        dob: data.patient_dob,
        phone: data.patient_phone,
        email: data.patient_email
      },
      transcript: (data.intake_messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
      summary: data.clinical_summaries || null
    };

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="intake-${id}.json"`);
    return res.status(200).send(JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error("export json error", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});

// deps: npm i pdfkit
const PDFDocument = require("pdfkit");

// GET /doctor/intake/:id/export/pdf
router.get("/intake/:id/export/pdf", async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await sb
      .from("intake_sessions")
      .select(`
        id, status, submitted_at, closed_at,
        patient_name, patient_dob, patient_phone, patient_email,
        intake_messages ( role, content, created_at ),
        clinical_summaries ( soap, ddx, icd10_codes, red_flags, updated_at, created_at )
      `)
      .eq("id", id).single();
    if (error) return res.status(404).json({ error: error.message });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="intake-${id}.pdf"`);

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // Header
    doc.fontSize(16).text("Clinical Intake Summary", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(10).text(`Session: ${data.id}`);
    doc.text(`Submitted: ${new Date(data.submitted_at).toLocaleString()}`);
    if (data.closed_at) doc.text(`Closed: ${new Date(data.closed_at).toLocaleString()}`);
    doc.moveDown();

    // Patient
    doc.fontSize(12).text("Patient", { underline: true });
    doc.fontSize(10).text(`Name: ${data.patient_name || "-"}`);
    doc.text(`DOB: ${data.patient_dob || "-"}`);
    doc.text(`Phone: ${data.patient_phone || "-"}`);
    doc.text(`Email: ${data.patient_email || "-"}`);
    doc.moveDown();

    // Summary
    const sum = data.clinical_summaries || {};
    doc.fontSize(12).text("SOAP", { underline: true });
    doc.fontSize(10).text(`Subjective: ${sum.soap?.subjective || "-"}`).moveDown(0.3);
    doc.text(`Objective: ${sum.soap?.objective || "-"}`).moveDown(0.3);
    if (Array.isArray(sum.soap?.assessment)) {
      doc.text("Assessment:");
      sum.soap.assessment.forEach((a, i) => doc.text(`  ${i + 1}. ${a.condition} — ${a.rationale || ""}`));
      doc.moveDown(0.3);
    }
    if (Array.isArray(sum.soap?.plan)) {
      doc.text("Plan:");
      sum.soap.plan.forEach((p, i) => doc.text(`  - ${p}`));
      doc.moveDown();
    }

    if (Array.isArray(sum.ddx)) {
      doc.fontSize(12).text("Differential Diagnosis", { underline: true });
      doc.fontSize(10);
      sum.ddx.forEach((d, i) => doc.text(`${i + 1}. ${d.condition} (${Math.round((d.likelihood || 0) * 100)}%) — ${d.rationale || ""}`));
      doc.moveDown();
    }

    if (Array.isArray(sum.icd10_codes)) {
      doc.fontSize(12).text("ICD-10 Codes", { underline: true });
      doc.fontSize(10).text(sum.icd10_codes.join(", ") || "-");
      doc.moveDown();
    }

    if (Array.isArray(sum.red_flags) && sum.red_flags.length) {
      doc.fontSize(12).text("Red Flags", { underline: true });
      doc.fontSize(10);
      sum.red_flags.forEach((r, i) => doc.text(`${i + 1}. ${r.flag} — ${r.reason || ""}`));
      doc.moveDown();
    }

    // Transcript (last)
    doc.addPage();
    doc.fontSize(12).text("Transcript", { underline: true });
    doc.moveDown(0.5);
    const msgs = (data.intake_messages || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    doc.fontSize(10);
    msgs.forEach((m) => {
      const who = m.role === "patient" ? "PATIENT" : "AGENT";
      doc.text(`[${who}] ${m.content}`);
    });

    doc.end();
  } catch (e) {
    console.error("export pdf error", e);
    res.status(500).json({ error: e?.message || "Server error" });
  }
});


module.exports = router;