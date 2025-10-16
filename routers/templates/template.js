// routes/templates.js
const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

// Supabase client (service role on server only)
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// Allowed types
const TYPES = new Set(["soap", "snippet", "prompt", "checklist"]);

/* ---------------------------- Helper utilities ---------------------------- */
async function getColumnByName(name) {
  const { data, error } = await sb
    .from("template_columns")
    .select("id, name, position")
    .eq("name", name)
    .single();
  if (error || !data) return null;
  return data;
}

async function getColumnById(id) {
  const { data, error } = await sb
    .from("template_columns")
    .select("id, name, position")
    .eq("id", id)
    .single();
  if (error || !data) return null;
  return data;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function isUUID(v) { return /^[0-9a-fA-F-]{36}$/.test(String(v || "")); }

/* --------------------------------- Columns -------------------------------- */
// GET /templates/columns  -> { columns: Column[] }
router.get("/columns", async (_req, res) => {
  try {
    const { data, error } = await sb
      .from("template_columns")
      .select("id, name, position")
      .order("position", { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ columns: data || [] });
  } catch (e) {
    console.error("GET /templates/columns", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------------- List ---------------------------------- */
// GET /templates?q&type&tag&column_id&limit&offset  -> { items, count }
router.get("/", async (req, res) => {
  try {
    const { q, type, tag, column_id, limit = "50", offset = "0" } = req.query;

    let query = sb
      .from("note_templates")
      .select(
        "id, column_id, type, title, tags, content, is_approved, updated_at, created_at",
        { count: "exact" }
      );

    if (type && TYPES.has(type)) query = query.eq("type", type);
    if (column_id && isUUID(column_id)) query = query.eq("column_id", column_id);
    if (tag) query = query.contains("tags", [tag]); // tags is text[]
    if (q) query = query.ilike("title", `%${q}%`);

    const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const start = Math.max(parseInt(offset, 10) || 0, 0);
    const end = start + size - 1;

    query = query.order("updated_at", { ascending: false }).range(start, end);

    const { data, error, count } = await query;
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ items: data || [], count: count || 0 });
  } catch (e) {
    console.error("GET /templates", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------------- Create --------------------------------- */
// POST /templates  body: { column_id? | column_name?, type, title, tags?, content } -> { item }
router.post("/", async (req, res) => {
  try {
    let { column_id, column_name, type, title, tags = [], content } = req.body || {};
    title = String(title || "").trim();

    if (!title) return res.status(400).json({ error: "title is required" });
    if (!type || !TYPES.has(type)) return res.status(400).json({ error: "invalid type" });
    if (!content || typeof content !== "object") return res.status(400).json({ error: "content (json) is required" });

    // Resolve column
    let col = null;
    if (column_id && isUUID(column_id)) col = await getColumnById(column_id);
    else if (column_name) col = await getColumnByName(column_name);
    else col = await getColumnByName("Backlog"); // default

    if (!col) return res.status(400).json({ error: "invalid column" });

    const { data, error } = await sb
      .from("note_templates")
      .insert([{
        column_id: col.id,
        type,
        title,
        tags,
        content,
        is_approved: false,
      }])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ item: data });
  } catch (e) {
    console.error("POST /templates", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------------- Read One -------------------------------- */
// GET /templates/:id -> { item }
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: "Invalid id" });
    const { data, error } = await sb
      .from("note_templates")
      .select("id, column_id, type, title, tags, content, is_approved, updated_at, created_at")
      .eq("id", id)
      .single();
    if (error) return res.status(404).json({ error: "Not found" });
    return res.json({ item: data });
  } catch (e) {
    console.error("GET /templates/:id", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------------- Update --------------------------------- */
// PATCH /templates/:id  body: { title?, tags?, content?, is_approved?, column_id? | column_name? } -> { item }
router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: "Invalid id" });

    const payload = pick(req.body || {}, ["title", "tags", "content", "is_approved"]);
    let { column_id, column_name } = req.body || {};

    // Move by column_id or column_name
    if (column_id || column_name) {
      const col = column_id && isUUID(column_id) ? await getColumnById(column_id) : await getColumnByName(column_name || "");
      if (!col) return res.status(400).json({ error: "invalid column" });
      payload.column_id = col.id;
    }

    if (payload.title) payload.title = String(payload.title).trim();
    if (payload.content && typeof payload.content !== "object") {
      return res.status(400).json({ error: "content must be JSON" });
    }

    // If approving, auto-move to Approved (Ready) if no explicit column given
    if (payload.is_approved === true && !payload.column_id) {
      const approvedLane = await getColumnByName("Approved (Ready)");
      if (approvedLane) payload.column_id = approvedLane.id;
    }

    const { data, error } = await sb
      .from("note_templates")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Not found" });
    return res.json({ item: data });
  } catch (e) {
    console.error("PATCH /templates/:id", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------------- Move ---------------------------------- */
// POST /templates/:id/move  body: { to_column_id? | to_column_name? } -> { item }
router.post("/:id/move", async (req, res) => {
  try {
    const { id } = req.params;
    const { to_column_id, to_column_name } = req.body || {};
    if (!isUUID(id)) return res.status(400).json({ error: "Invalid id" });

    const col = to_column_id && isUUID(to_column_id)
      ? await getColumnById(to_column_id)
      : await getColumnByName(to_column_name || "");

    if (!col) return res.status(400).json({ error: "invalid target column" });

    const { data, error } = await sb
      .from("note_templates")
      .update({ column_id: col.id, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    if (!data) return res.status(404).json({ error: "Not found" });

    return res.json({ item: data });
  } catch (e) {
    console.error("POST /templates/:id/move", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ------------------------------- Duplicate -------------------------------- */
// POST /templates/:id/duplicate  -> { item }
router.post("/:id/duplicate", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isUUID(id)) return res.status(400).json({ error: "Invalid id" });

    const { data: original, error: readErr } = await sb
      .from("note_templates")
      .select("id, column_id, type, title, tags, content, is_approved")
      .eq("id", id)
      .single();

    if (readErr || !original) return res.status(404).json({ error: "Not found" });

    let targetLane = await getColumnByName("Drafting");
    if (!targetLane) targetLane = await getColumnById(original.column_id);

    const copy = {
      column_id: targetLane.id,
      type: original.type,
      title: `${original.title} (copy)`,
      tags: original.tags || [],
      content: original.content,
      is_approved: false,
    };

    const { data, error } = await sb
      .from("note_templates")
      .insert([copy])
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ item: data });
  } catch (e) {
    console.error("POST /templates/:id/duplicate", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* --------------------------------- Library -------------------------------- */
// GET /templates/library/list?type&tag&q&limit&offset  -> { items }
router.get("/library/list", async (req, res) => {
  try {
    const { type, tag, q, limit = "50", offset = "0" } = req.query;

    let query = sb
      .from("note_templates")
      .select("id, type, title, tags, content, updated_at")
      .eq("is_approved", true);

    if (type && TYPES.has(type)) query = query.eq("type", type);
    if (tag) query = query.contains("tags", [tag]);
    if (q) query = query.ilike("title", `%${q}%`);

    const size = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const start = Math.max(parseInt(offset, 10) || 0, 0);
    const end = start + size - 1;

    query = query.order("updated_at", { ascending: false }).range(start, end);

    const { data, error } = await query;
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ items: data || [] });
  } catch (e) {
    console.error("GET /templates/library/list", e);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------------------------------- Delete -------------------------------- */
// DELETE /templates/:id
// Default: 204 (no body)
// If ?return=1, respond 200 with the deleted row { item: ... }
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const wantsRow = String(req.query.return) === "1";
    if (!isUUID(id)) return res.status(400).json({ error: "Invalid id" });

    const { data, error } = await sb
      .from("note_templates")
      .delete()
      .eq("id", id)
      .select("id, column_id, type, title, tags, content, is_approved, updated_at, created_at")
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });
    if (!Array.isArray(data) || data.length === 0) return res.status(404).json({ error: "Not found" });

    if (wantsRow) return res.status(200).json({ item: data[0] });
    return res.status(204).end();
  } catch (e) {
    console.error("DELETE /templates/:id", e);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
