
const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

const BASE_SOURCES = "site:moneycontrol.com OR site:reuters.com OR site:economictimes.indiatimes.com OR site:livemint.com OR site:bloomberg.com";
const CRYPTO_SOURCES = "site:coindesk.com OR site:cointelegraph.com OR site:reuters.com OR site:bloomberg.com";

const BASE_INSTRUMENTS = [
  { symbol: "EURUSD", instrument: "EUR/USD", type: "forex" },
  { symbol: "EURINR", instrument: "EUR/INR", type: "forex" },
  { symbol: "USDINR", instrument: "USD/INR", type: "forex" },
  { symbol: "INFY", instrument: "Infosys Ltd", type: "equity" },
  { symbol: "TCS", instrument: "Tata Consultancy Services", type: "equity" },
  { symbol: "RELIANCE", instrument: "Reliance Industries", type: "equity" },
  { symbol: "ICICIBANK", instrument: "ICICI Bank", type: "equity" },
  { symbol: "HDFCBANK", instrument: "HDFC Bank", type: "equity" },
  { symbol: "SBIN", instrument: "State Bank of India", type: "equity" },
  { symbol: "BTCUSDT", instrument: "Bitcoin / USDT", type: "crypto" },
  { symbol: "ETHUSDT", instrument: "Ethereum / USDT", type: "crypto" },
  { symbol: "SOLUSDT", instrument: "Solana / USDT", type: "crypto" },

];

const INSTRUMENTS = Object.fromEntries(
  BASE_INSTRUMENTS.map(({ symbol, instrument, type }) => {
    let query;

    if (type === "forex") {
      query = `${symbol} OR ${instrument} OR exchange rate ${BASE_SOURCES}`;
    } else if (type === "crypto") {
      query = `${symbol} OR ${instrument} OR crypto OR price ${CRYPTO_SOURCES}`;
    } else {
      query = `${symbol} OR ${instrument} stock ${BASE_SOURCES}`;
    }
    return [symbol, { instrument, query }];
  })
);


// IMPORTANT: use Service Role on backend
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: "market_data" } }
);

// helpers for DB access
async function getLatestSnapshot(symbol) {
  const { data, error } = await sb
    .from("mood_snapshots")
    .select("symbol,instrument,sentiment_label,sentiment_score,snapshot,captured_at")
    .eq("symbol", symbol)
    .order("captured_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function getRecentHeadlines(symbol, limit = 100) {
  const { data, error } = await sb
    .from("mood_headlines")
    .select("headline_id,title,summary,sentiment,source,link,published_at,captured_at")
    .eq("symbol", symbol)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw error;
  // map to FE shape
  return (data || []).map((h) => ({
    id: h.headline_id,
    title: h.title,
    sentiment: h.sentiment,
    timestamp: h.published_at || h.captured_at,
    source: h.source || "News",
    summary: h.summary,
    link: h.link || undefined,
  }));
}

// trend from past N snapshots (maps to 30/50/70 buckets)
async function getTrendFromSnapshots(symbol, n = 60) {
  const { data, error } = await sb
    .from("mood_snapshots")
    .select("captured_at,sentiment_label,sentiment_score")
    .eq("symbol", symbol)
    .order("captured_at", { ascending: false })
    .limit(n);
  if (error) throw error;
  const map = { positive: 70, neutral: 50, negative: 30 };
  return (data || [])
    .reverse() // chronological
    .map((r) => ({
      t: r.captured_at,
      score: map[r.sanitment_label] || map[r.sentiment_label] || Math.round((r.sentiment_score || 0.5) * 100),
    }));
}


// -----------------------------------
// Endpoint 1: Snapshots Grid (from DB)
// -----------------------------------
router.get("/snapshots", async (req, res) => {
  const limitTop = parseInt(req.query.limitTopHeadlines || 3, 10);
  const returnTrend = req.query.returnTrend === "true";

  try {
    const results = [];

    // One query per symbol (9 total) is fine, simplest + clear
    for (const { symbol } of BASE_INSTRUMENTS) {
      const row = await getLatestSnapshot(symbol);

      if (!row) {
        // no data yet for this symbol -> send a safe placeholder
        results.push({
          instrument: INSTRUMENTS[symbol]?.instrument || symbol,
          symbol,
          sentiment: "neutral",
          sentimentScore: 0.5,
          trend: [],
          headlines: [],
          summary: `${symbol} awaiting first snapshot`,
        });
        continue;
      }

      const snap = row.snapshot || {};
      // prefer values from snapshot payload (created by your cron), fall back to columns
      const sentiment = snap.sentiment || row.sentiment_label || "neutral";
      const sentimentScore =
        typeof snap.sentimentScore === "number" ? snap.sentimentScore : Number(row.sentiment_score || 0.5);
      const instrumentName = snap.instrument || row.instrument || INSTRUMENTS[symbol]?.instrument || symbol;

      // headlines: prefer latest from DB, fall back to snapshot payload if none
      let headlines = await getRecentHeadlines(symbol, limitTop);
      if (!headlines.length && Array.isArray(snap.headlines)) {
        headlines = snap.headlines.slice(0, limitTop);
      }

      // trend: optional → pull last ~9 snapshots to emulate sparkline
      let trend = [];
      if (returnTrend) {
        const spark = await getTrendFromSnapshots(symbol, 9);
        // convert numeric scores (30/50/70) to 0–100 pct sparkline values
        trend = spark.map((p) => Math.round((p.score / 100) * 100));
      }

      results.push({
        instrument: instrumentName,
        symbol,
        sentiment,
        sentimentScore,
        trend,
        headlines,
        summary: snap.summary || "—",
      });
    }

    res.json(results);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_fetch_snapshots", detail: e?.message });
  }
});



// -----------------------------------
// Endpoint 2: Instrument Detail (from DB)
// -----------------------------------
router.get("/instruments/:symbol", async (req, res) => {
  const symbol = (req.params.symbol || "").toUpperCase();
  const includeTrend = req.query.includeTrend !== "false";
  const limit = parseInt(req.query.limitHeadlines || 100, 10);

  if (!INSTRUMENTS[symbol]) {
    return res.status(404).json({ error: "unknown_symbol", known: Object.keys(INSTRUMENTS) });
  }

  try {
    const latest = await getLatestSnapshot(symbol);

    if (!latest) {
      return res.status(404).json({ error: "no_snapshot_for_symbol", symbol });
    }

    const snap = latest.snapshot || {};
    const instrument = snap.instrument || latest.instrument || INSTRUMENTS[symbol].instrument;
    const sentiment = snap.sentiment || latest.sentiment_label || "neutral";
    const sentimentScore =
      typeof snap.sentimentScore === "number" ? snap.sentimentScore : Number(latest.sentiment_score || 0.5);
    const summary = snap.summary || "—";

    // headlines: prefer full list from per-headline table to honor `limit`
    const headlines = await getRecentHeadlines(symbol, limit);

    // trend: build from past snapshots
    let trendDetailed = [];
    if (includeTrend) {
      trendDetailed = await getTrendFromSnapshots(symbol, 60);
    }

    res.json({
      instrument,
      symbol,
      sentiment,
      sentimentScore,
      summary,
      trend: trendDetailed,
      headlines,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "failed_to_fetch_detail", detail: e?.message });
  }
});


module.exports = router;
