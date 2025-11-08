// routes/calendar.api.js
// One-file Express router (CommonJS) for AlphaPulse Calendar (read APIs)
// Backed by two tables only: market_data.calendar_events, market_data.calendar_event_sentiment
//
// Endpoints:
//   GET  /healthz
//   GET  /calendar/events                → list with filters + cursor; joined with sentiment
//   GET  /calendar/events/:id            → single event + sentiment
//   GET  /calendar/summary               → aggregates for filters panel & KPI chips
//   GET  /calendar/sentiment/overview    → score histogram + trend counts within window
//
// Usage:
//   const express = require("express");
//   const app = express();
//   const calendarApi = require("./routes/calendar.api");
//   app.use(express.json());
//   app.use("/", calendarApi);
//   app.listen(8000);

const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

// --------------------------- Supabase ---------------------------
const SCHEMA = process.env.DB_SCHEMA || "market_data";
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY, // Service Role (server-side only)
  { db: { schema: SCHEMA } }
);

// --------------------------- Utils ------------------------------
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function decodeCursor(tok) {
  try {
    if (!tok) return null;
    return JSON.parse(Buffer.from(tok, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function safeNum(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}
function startOfUTCDate(d) {
  const dt = new Date(d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.toISOString();
}
function endOfUTCDate(d) {
  const dt = new Date(d);
  dt.setUTCHours(23, 59, 59, 999);
  return dt.toISOString();
}

router.get("/healthz", (_req, res) => res.json({ ok: true }));

// ===================================================================
// GET /calendar/events
// Query:
//   from, to                 (ISO, defaults [now-2d, now+14d])
//   market, impact, type     (exact matches)
//   q                        (title ilike %q%)
//   symbols[]=               (array overlap)
//   limit, cursor            (pagination; cursor = base64url({datetime_utc,id}))
// Response:
//   { items: [ { ...calendar_events, score, trend } ], next?: string }
// ===================================================================
router.get("/events", async (req, res) => {
  try {
    const {
      from: fromISO,
      to: toISO,
      market,
      impact,
      type,
      q: search,
      limit = "50",
      cursor,
    } = req.query;

    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);

    // base window defaults
    const from =
      fromISO ||
      new Date(Date.now() - 2 * 86400e3).toISOString();
    const to =
      toISO ||
      new Date(Date.now() + 14 * 86400e3).toISOString();

    let query = sb
      .from("calendar_events")
      .select("*")
      .gte("datetime_utc", from)
      .lte("datetime_utc", to)
      .order("datetime_utc", { ascending: true })
      .order("id", { ascending: true });

    if (market) query = query.eq("market", market);
    if (impact) query = query.eq("impact", impact);
    if (type) query = query.eq("type", type);
    if (search) query = query.ilike("title", `%${search}%`);

    const symbols = []
      .concat(req.query.symbols || [])
      .filter(Boolean)
      .map(String);
    if (symbols.length) query = query.overlaps("symbols", symbols);

    // cursor (datetime_utc, id)
    const cur = decodeCursor(cursor);
    if (cur?.datetime_utc && cur?.id) {
      const cdt = encodeURIComponent(cur.datetime_utc);
      const cid = encodeURIComponent(cur.id);
      // supabase or() syntax
      // query = query.or(
      //   `datetime_utc.gt.${cdt},and(datetime_utc.eq.${cdt},id.gt.${cid})`
      // );

      query = query.or(`datetime_utc.gt.${cur.datetime_utc},and(datetime_utc.eq.${cur.datetime_utc},id.gt.${cur.id})`)

    }

    query = query.limit(limitNum + 1); // fetch one extra to detect next

    const { data: events, error: evErr } = await query;
    if (evErr) throw evErr;

    const hasNext = events.length > limitNum;
    const slice = events.slice(0, limitNum);

    // fetch sentiments for these events
    const ids = slice.map((e) => e.id);
    let byId = {};
    if (ids.length) {
      const { data: sents, error: sErr } = await sb
        .from("calendar_event_sentiment")
        .select("event_id,score,trend")
        .in("event_id", ids);
      if (sErr) throw sErr;
      byId = Object.fromEntries((sents || []).map((r) => [r.event_id, r]));
    }

    const items = slice.map((e) => ({
      ...e,
      score: byId[e.id]?.score ?? null,
      trend: byId[e.id]?.trend ?? null,
    }));

    const next = hasNext
      ? encodeCursor({
        datetime_utc: items[items.length - 1].datetime_utc,
        id: items[items.length - 1].id,
      })
      : null;

    res.json({ items, next });
  } catch (e) {
    console.error("GET /calendar/events error:", e);
    res
      .status(500)
      .json({ error: "failed_to_list_events", detail: String(e.message || e) });
  }
});

// ===================================================================
// GET /calendar/events/:id
// Returns: single event merged with sentiment (score, trend)
// ===================================================================
router.get("/events/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const { data: ev, error: evErr } = await sb
      .from("calendar_events")
      .select("*")
      .eq("id", id)
      .single();
    if (evErr && evErr.code !== "PGRST116") throw evErr;
    if (!ev) return res.status(404).json({ error: "not_found" });

    const { data: sent, error: sErr } = await sb
      .from("calendar_event_sentiment")
      .select("event_id,score,trend,window_hours,updated_at")
      .eq("event_id", id)
      .maybeSingle();
    if (sErr) throw sErr;

    res.json({
      ...ev,
      score: sent?.score ?? null,
      trend: sent?.trend ?? null,
      window_hours: sent?.window_hours ?? null,
      sentiment_updated_at: sent?.updated_at ?? null,
    });
  } catch (e) {
    console.error("GET /calendar/events/:id error:", e);
    res
      .status(500)
      .json({ error: "failed_to_get_event", detail: String(e.message || e) });
  }
});

// ===================================================================
// GET /calendar/summary
// Aggregates to power filters/KPIs for the visible range.
// Query: from, to, market, impact, type, q, symbols[]=
// Response:
//   {
//     totals: { count },
//     byImpact: { high, medium, low },
//     byMarket: { IN: n, US: n, ... },
//     byType:   { macro: n, earnings: n, ... },
//     byDate:   [ { date: 'YYYY-MM-DD', count }, ... ],
//     symbolsTop: [ { symbol, count }, ... up to 25 ]
//   }
// ===================================================================
router.get("/summary", async (req, res) => {
  try {
    const { from: fromISO, to: toISO, market, impact, type, q: search } = req.query;

    const from =
      fromISO ||
      new Date(Date.now() - 2 * 86400e3).toISOString();
    const to =
      toISO ||
      new Date(Date.now() + 14 * 86400e3).toISOString();

    let query = sb
      .from("calendar_events")
      .select("id,datetime_utc,impact,market,type,symbols")
      .gte("datetime_utc", from)
      .lte("datetime_utc", to)
      .order("datetime_utc", { ascending: true });

    if (market) query = query.eq("market", market);
    if (impact) query = query.eq("impact", impact);
    if (type) query = query.eq("type", type);
    if (search) query = query.ilike("title", `%${search}%`);

    const symbols = []
      .concat(req.query.symbols || [])
      .filter(Boolean)
      .map(String);
    if (symbols.length) query = query.overlaps("symbols", symbols);

    const { data, error } = await query.limit(5000);
    if (error) throw error;

    const byImpact = { high: 0, medium: 0, low: 0 };
    const byMarket = {};
    const byType = {};
    const byDateMap = new Map();
    const symCount = new Map();

    for (const e of data || []) {
      byImpact[e.impact] = (byImpact[e.impact] || 0) + 1;
      byMarket[e.market] = (byMarket[e.market] || 0) + 1;
      byType[e.type] = (byType[e.type] || 0) + 1;

      const d = (e.datetime_utc || "").slice(0, 10); // YYYY-MM-DD
      byDateMap.set(d, (byDateMap.get(d) || 0) + 1);

      if (Array.isArray(e.symbols)) {
        for (const s of e.symbols) {
          symCount.set(s, (symCount.get(s) || 0) + 1);
        }
      }
    }

    const byDate = Array.from(byDateMap.entries()).map(([date, count]) => ({ date, count }));
    const symbolsTop = Array.from(symCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([symbol, count]) => ({ symbol, count }));

    res.json({
      totals: { count: (data || []).length },
      byImpact,
      byMarket,
      byType,
      byDate,
      symbolsTop,
    });
  } catch (e) {
    console.error("GET /calendar/summary error:", e);
    res
      .status(500)
      .json({ error: "failed_to_build_summary", detail: String(e.message || e) });
  }
});

// ===================================================================
// GET /calendar/sentiment/overview
// Histogram & trend counts for sentiments within time window (joined with events)
// Query: from, to, symbols[]= (optional)
// Response:
//   {
//     buckets: [ { min:-1, max:-0.6, count }, ... ],
//     trendCounts: { rising, flat, falling },
//     sample: n
//   }
// ===================================================================
router.get("/sentiment/overview", async (req, res) => {
  try {
    const { from: fromISO, to: toISO } = req.query;
    const from =
      fromISO ||
      new Date(Date.now() - 14 * 86400e3).toISOString();
    const to =
      toISO ||
      new Date(Date.now() + 1 * 86400e3).toISOString();

    // events in window
    let evQ = sb
      .from("calendar_events")
      .select("id,symbols,datetime_utc")
      .gte("datetime_utc", from)
      .lte("datetime_utc", to)
      .order("datetime_utc", { ascending: false })
      .limit(5000);

    const symbols = []
      .concat(req.query.symbols || [])
      .filter(Boolean)
      .map(String);
    if (symbols.length) evQ = evQ.overlaps("symbols", symbols);

    const { data: evs, error: evErr } = await evQ;
    if (evErr) throw evErr;

    const ids = (evs || []).map((e) => e.id);
    if (!ids.length) return res.json({ buckets: [], trendCounts: { rising: 0, flat: 0, falling: 0 }, sample: 0 });

    const { data: sents, error: sErr } = await sb
      .from("calendar_event_sentiment")
      .select("event_id,score,trend")
      .in("event_id", ids);
    if (sErr) throw sErr;

    const edges = [-1, -0.6, -0.2, 0.2, 0.6, 1.00001]; // 5 buckets
    const buckets = Array(edges.length - 1).fill(0);
    const trendCounts = { rising: 0, flat: 0, falling: 0 };

    for (const r of sents || []) {
      const score = safeNum(r.score, NaN);
      if (Number.isFinite(score)) {
        for (let i = 0; i < edges.length - 1; i++) {
          if (score >= edges[i] && score < edges[i + 1]) {
            buckets[i] += 1;
            break;
          }
        }
      }
      if (r.trend && trendCounts[r.trend] != null) trendCounts[r.trend] += 1;
    }

    const outBuckets = [];
    for (let i = 0; i < buckets.length; i++) {
      outBuckets.push({ min: edges[i], max: edges[i + 1], count: buckets[i] });
    }

    res.json({ buckets: outBuckets, trendCounts, sample: (sents || []).length });
  } catch (e) {
    console.error("GET /calendar/sentiment/overview error:", e);
    res
      .status(500)
      .json({ error: "failed_to_build_sentiment_overview", detail: String(e.message || e) });
  }
});

module.exports = router;
