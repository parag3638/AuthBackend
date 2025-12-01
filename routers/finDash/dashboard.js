// dashboard.js — one-call overview for KPI + charts + movers + mood
// Usage in index.js: app.use("/dashboard", require("./dashboard"));

const express = require("express");
const router = express.Router();
const { createClient } = require("@supabase/supabase-js");

// --------------------------- Supabase ---------------------------
const SCHEMA = process.env.DB_SCHEMA || "market_data";
const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY, // service role; server only
    { db: { schema: SCHEMA } }
);

// --------------------------- Utils ------------------------------
const toISODate = (d) => new Date(d).toISOString().slice(0, 10);
const todayUTC = () => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
const parseBool = (v, def = false) => {
    if (v == null) return def;
    const s = String(v).toLowerCase();
    return s === "true" || s === "1" || s === "yes";
};
const csvOrRepeatable = (q, key) =>
    Array.isArray(q[key])
        ? q[key].filter(Boolean)
        : q[key]
            ? String(q[key]).split(",").map((s) => s.trim()).filter(Boolean)
            : null;

const safeNum = (x, def = null) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : def;
};

// --------------------------- PRICES HELPERS ---------------------
// Mirrors your prices.js logic: 1m LTP vs previous 1d close

// async function fetchLatestBar1m(instrumentId) {
//     const { data, error } = await sb
//         .from("price_bars_1m")
//         .select("open,high,low,close,volume,ts")
//         .eq("instrument_id", instrumentId)
//         .order("ts", { ascending: false })
//         .limit(1)
//         .maybeSingle();
//     if (error) throw error;
//     return data || null;
// }

// async function fetchDailyChangeIntraday(instrumentId) {
//     const today = new Date().toISOString().slice(0, 10);

//     // prev official close
//     const { data: prevRows, error: prevErr } = await sb
//         .from("price_bars_1d")
//         .select("dt, close")
//         .eq("instrument_id", instrumentId)
//         .lt("dt", today)
//         .order("dt", { ascending: false })
//         .limit(1);
//     if (prevErr) throw prevErr;

//     const prevClose = prevRows?.[0]?.close != null ? Number(prevRows[0].close) : null;
//     const prevDt = prevRows?.[0]?.dt ?? null;

//     // latest intraday
//     const bar = await fetchLatestBar1m(instrumentId);
//     const lastPrice = bar?.close != null ? Number(bar.close) : null;
//     const lastTs = bar?.ts ?? null;

//     if (lastPrice == null || prevClose == null) {
//         // fallback: two latest daily closes
//         const { data: dailies, error: dErr } = await sb
//             .from("price_bars_1d")
//             .select("dt, close")
//             .eq("instrument_id", instrumentId)
//             .order("dt", { ascending: false })
//             .limit(3);
//         if (dErr) throw dErr;

//         const unique = [];
//         const seen = new Set();
//         for (const r of dailies || []) {
//             if (!seen.has(r.dt)) {
//                 seen.add(r.dt);
//                 unique.push(r);
//             }
//             if (unique.length === 2) break;
//         }
//         const latest = unique[0];
//         const prev = unique[1];

//         const lastClose = latest?.close != null ? Number(latest.close) : null;
//         const prevClose2 = prev?.close != null ? Number(prev.close) : null;

//         if (lastClose == null || prevClose2 == null) {
//             return { lastPrice, prevClose, change: null, change_pct: null, last_dt: latest?.dt ?? null, basis: "fallback-none" };
//         }
//         const change = lastClose - prevClose2;
//         const change_pct = prevClose2 !== 0 ? (change / prevClose2) * 100 : null;
//         return { lastPrice: lastClose, prevClose: prevClose2, change, change_pct, last_dt: latest.dt, basis: "two-distinct-daily-closes" };
//     }

//     // primary path
//     const change = lastPrice - prevClose;
//     const change_pct = prevClose !== 0 ? (change / prevClose) * 100 : null;
//     return { lastPrice, prevClose, change, change_pct, last_dt: prevDt, last_ts: lastTs, basis: "ltp-vs-prevClose" };
// }

function getInstrumentFilter(categoryRaw) {
    const category = String(categoryRaw || "nifty").toLowerCase();
    const allowed = new Set(["all", "nifty", "crypto", "forex"]);
    const cat = allowed.has(category) ? category : "nifty";

    const apply = (query) => {
        if (cat === "all") return query.eq("active", true);
        if (cat === "nifty") {
            return query.eq("active", true).in("asset", ["index", "equity"]).eq("exchanges.code", "NSE");
        }
        if (cat === "crypto") return query.eq("active", true).eq("asset", "crypto");
        if (cat === "forex") return query.eq("active", true).eq("asset", "forex");
        return query.eq("active", true);
    };

    return { category: cat, apply };
}

async function pricesOverview(rawCategory, limitMovers = 5) {
    const { category, apply } = getInstrumentFilter(rawCategory);

    let query = sb
        .from("instruments")
        .select("id,symbol,name,asset,exchange_id,exchanges:exchanges!instruments_exchange_id_fkey(id,code,name,venue,tz)")
        .order("symbol", { ascending: true });

    query = apply(query);

    const { data: instruments, error: instErr } = await query;
    if (instErr) throw instErr;

    if (!instruments?.length) {
        return { snapshotTs: null, tracked: 0, movers: { gainers: [], losers: [] } };
    }

    const instrumentIds = instruments.map((i) => i.id);

    // 1) Latest 1m bar per instrument (single query)
    const { data: intradayRows, error: intradayErr } = await sb
        .from("price_bars_1m")
        .select("instrument_id, ts, open, high, low, close, volume")
        .in("instrument_id", instrumentIds)
        .order("instrument_id", { ascending: true })
        .order("ts", { ascending: false });

    if (intradayErr) throw intradayErr;

    const latest1mByInstrument = new Map();
    for (const row of intradayRows || []) {
        if (!latest1mByInstrument.has(row.instrument_id)) {
            latest1mByInstrument.set(row.instrument_id, {
                ts: row.ts,
                open: safeNum(row.open),
                high: safeNum(row.high),
                low: safeNum(row.low),
                close: safeNum(row.close),
                volume: safeNum(row.volume),
            });
        }
    }

    // 2) Last few daily bars per instrument (single query)
    // Optional: restrict to recent dt (e.g. last 60 days) if table is huge
    const { data: dailyRows, error: dailyErr } = await sb
        .from("price_bars_1d")
        .select("instrument_id, dt, close")
        .in("instrument_id", instrumentIds)
        .order("instrument_id", { ascending: true })
        .order("dt", { ascending: false });

    if (dailyErr) throw dailyErr;

    const dailyByInstrument = new Map();

    for (const row of dailyRows || []) {
        const arr = dailyByInstrument.get(row.instrument_id) || [];
        // keep only a few recent entries per instrument for safety
        if (arr.length < 4) {
            arr.push({
                dt: row.dt,
                close: safeNum(row.close),
            });
            dailyByInstrument.set(row.instrument_id, arr);
        }
    }

    function computeDailyChange(instId) {
        const arr = dailyByInstrument.get(instId) || [];
        if (!arr.length) {
            return {
                lastClose: null,
                prevClose: null,
                change: null,
                change_pct: null,
                last_dt: null,
            };
        }

        // ensure distinct dates just in case
        const uniqueByDate = [];
        const seen = new Set();
        for (const r of arr) {
            if (!seen.has(r.dt)) {
                seen.add(r.dt);
                uniqueByDate.push(r);
            }
            if (uniqueByDate.length === 2) break;
        }

        const latest = uniqueByDate[0];
        const prev = uniqueByDate[1];

        const lastClose = latest?.close ?? null;
        const prevClose = prev?.close ?? null;

        if (lastClose == null || prevClose == null) {
            return {
                lastClose,
                prevClose,
                change: null,
                change_pct: null,
                last_dt: latest?.dt ?? null,
            };
        }

        const change = lastClose - prevClose;
        const change_pct = prevClose !== 0 ? (change / prevClose) * 100 : null;

        return {
            lastClose,
            prevClose,
            change,
            change_pct,
            last_dt: latest?.dt ?? null,
        };
    }



    // const items = await Promise.all(
    //     instruments.map(async (inst) => {
    //         const [bar, daily] = await Promise.all([fetchLatestBar1m(inst.id), fetchDailyChangeIntraday(inst.id)]);
    //         return {
    //             symbol: inst.symbol,
    //             name: inst.name || inst.symbol,
    //             asset: inst.asset,
    //             exchange: inst.exchanges?.code ?? null,
    //             last_price: safeNum(bar?.close),
    //             last_updated: bar?.ts ?? null,
    //             last_close: daily.prevClose,
    //             prev_close: daily.prevClose,
    //             change: daily.change,
    //             change_pct: daily.change_pct,
    //             last_close_dt: daily.last_dt
    //         };
    //     })
    // );

    // // compute movers by change_pct
    // const valid = items.filter((i) => typeof i.change_pct === "number");
    // const sorted = [...valid].sort((a, b) => (b.change_pct ?? -Infinity) - (a.change_pct ?? -Infinity));
    // const gainers = sorted.slice(0, limitMovers);
    // const losers = sorted.slice(-limitMovers).reverse();

    // // snapshot ts = max of last_updated
    // const snapshotTs = items.reduce((acc, r) => (acc && r.last_updated && acc > r.last_updated ? acc : r.last_updated || acc), null);

    // return {
    //     snapshotTs,
    //     tracked: items.length,
    //     movers: { gainers, losers }
    // };

    const items = instruments.map((inst) => {
        const bar = latest1mByInstrument.get(inst.id) || null;
        const daily = computeDailyChange(inst.id);

        const last_price = bar?.close ?? daily.lastClose ?? null;
        const last_updated = bar?.ts ?? null;

        return {
            symbol: inst.symbol,
            name: inst.name || inst.symbol,
            asset: inst.asset,
            exchange: inst.exchanges?.code ?? null,
            last_price,
            last_updated,
            last_close: daily.lastClose,
            prev_close: daily.prevClose,
            change: daily.change,
            change_pct: daily.change_pct,
            last_close_dt: daily.last_dt,
        };
    });

    const valid = items.filter((i) => typeof i.change_pct === "number");

    const sorted = [...valid].sort(
        (a, b) => (b.change_pct ?? -Infinity) - (a.change_pct ?? -Infinity)
    );

    const gainers = sorted.slice(0, limitMovers);
    const losers = sorted.slice(-limitMovers).reverse();

    const snapshotTs = items.reduce(
        (acc, r) => (acc && r.last_updated && acc > r.last_updated ? acc : r.last_updated || acc),
        null
    );

    return {
        snapshotTs,
        tracked: items.length,
        movers: { gainers, losers },
    };
}


// --------------------------- CALENDAR HELPERS -------------------
async function calendarSummary({ from, to, market, impact, type, search, symbols }) {
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
    if (symbols?.length) query = query.overlaps("symbols", symbols);

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
        const d = (e.datetime_utc || "").slice(0, 10);
        byDateMap.set(d, (byDateMap.get(d) || 0) + 1);
        if (Array.isArray(e.symbols)) {
            for (const s of e.symbols) symCount.set(s, (symCount.get(s) || 0) + 1);
        }
    }

    const byDate = Array.from(byDateMap.entries()).map(([date, count]) => ({ date, count }));
    const symbolsTop = Array.from(symCount.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([symbol, count]) => ({ symbol, count }));

    const total = (data || []).length;
    return { byDate, byImpact, byMarket, byType, symbolsTop, total };
}

async function sentimentOverview({ from, to, symbols }) {
    // pull events in window then their sentiments
    let evQ = sb
        .from("calendar_events")
        .select("id,symbols,datetime_utc")
        .gte("datetime_utc", from)
        .lte("datetime_utc", to)
        .order("datetime_utc", { ascending: false })
        .limit(5000);

    if (symbols?.length) evQ = evQ.overlaps("symbols", symbols);

    const { data: evs, error: evErr } = await evQ;
    if (evErr) throw evErr;

    const ids = (evs || []).map((e) => e.id);
    if (!ids.length) return { histogram: [], trends: { rising: 0, flat: 0, falling: 0 } };

    const { data: sents, error: sErr } = await sb
        .from("calendar_event_sentiment")
        .select("event_id,score,trend")
        .in("event_id", ids);
    if (sErr) throw sErr;

    const edges = [-1, -0.6, -0.2, 0.2, 0.6, 1.00001]; // 5 buckets
    const buckets = Array(edges.length - 1).fill(0);
    const trends = { rising: 0, flat: 0, falling: 0 };

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
        if (r.trend && trends[r.trend] != null) trends[r.trend] += 1;
    }

    const histogram = [];
    for (let i = 0; i < buckets.length; i++) {
        histogram.push({ min: edges[i], max: edges[i + 1], count: buckets[i] });
    }
    return { histogram, trends };
}

// --------------------------- NEWS HELPERS -----------------------
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

    return (data || []).map((h) => ({
        id: h.headline_id,
        title: h.title,
        sentiment: h.sentiment,
        timestamp: h.published_at || h.captured_at,
        source: h.source || "News",
        summary: h.summary,
        link: h.link || undefined
    }));
}

// async function newsCards({ limitHeadlines = 3, returnTrend = false, baseInstruments = [] }) {
//     const results = [];

//     for (const { symbol, instrument } of baseInstruments) {
//         const row = await getLatestSnapshot(symbol);
//         if (!row) {
//             results.push({
//                 instrument: instrument || symbol,
//                 symbol,
//                 sentiment: "neutral",
//                 sentimentScore: 0.5,
//                 trend: [],
//                 headlines: [],
//                 summary: `${symbol} awaiting first snapshot`
//             });
//             continue;
//         }
//         const snap = row.snapshot || {};
//         const sentiment = snap.sentiment || row.sentiment_label || "neutral";
//         const sentimentScore = typeof snap.sentimentScore === "number" ? snap.sentimentScore : Number(row.sentiment_score || 0.5);
//         const instrumentName = snap.instrument || row.instrument || instrument || symbol;

//         let headlines = await getRecentHeadlines(symbol, limitHeadlines);
//         if (!headlines.length && Array.isArray(snap.headlines)) {
//             headlines = snap.headlines.slice(0, limitHeadlines);
//         }

//         const card = {
//             instrument: instrumentName,
//             symbol,
//             sentiment,
//             sentimentScore,
//             trend: [],
//             headlines,
//             summary: snap.summary || "—"
//         };

//         // optional trend: reuse last N snapshots and map to 0–100
//         if (returnTrend) {
//             const { data: snaps } = await sb
//                 .from("mood_snapshots")
//                 .select("captured_at,sentiment_label,sentiment_score")
//                 .eq("symbol", symbol)
//                 .order("captured_at", { ascending: false })
//                 .limit(9);
//             const map = { positive: 70, neutral: 50, negative: 30 };
//             card.trend = (snaps || [])
//                 .reverse()
//                 .map((r) => map[r.sentiment_label] ?? Math.round((Number(r.sentiment_score ?? 0.5)) * 100));
//         }

//         results.push(card);
//     }

//     // counts across window (simple totals from headlines)
//     const { data: counts } = await sb
//         .from("mood_headlines")
//         .select("symbol", { count: "exact", head: true });

//     const instrumentsCovered = counts?.length ?? 0;
//     const { data: hlCount } = await sb.from("mood_headlines").select("*", { count: "exact", head: true });

//     const { data: snapTsRow } = await sb
//         .from("mood_headlines")
//         .select("published_at")
//         .order("published_at", { ascending: false, nullsFirst: false })
//         .limit(1);

//     return {
//         instrumentsCovered,
//         headlinesIndexed: hlCount?.length ?? 0,
//         snapshotTs: snapTsRow?.[0]?.published_at ?? null,
//         cards: results
//     };
// }

// --------------------------- ROUTE ------------------------------

async function newsCards({
    limitHeadlines = 1,        // per instrument
    limitCards = 4,            // total cards you actually care about
    baseInstruments = [],
}) {
    const symbols = baseInstruments.map((b) => b.symbol);

    // 1) Latest snapshot PER symbol (one query)
    const { data: snaps, error: snapsErr } = await sb
        .from("mood_snapshots")
        .select("symbol,instrument,sentiment_label,sentiment_score,snapshot,captured_at")
        .in("symbol", symbols)
        .order("captured_at", { ascending: false });
    if (snapsErr) throw snapsErr;

    const latestSnapBySymbol = new Map();
    for (const row of snaps || []) {
        if (!latestSnapBySymbol.has(row.symbol)) {
            latestSnapBySymbol.set(row.symbol, row);
        }
    }

    // 2) Headlines for all symbols in one shot
    const { data: headlines, error: hlErr } = await sb
        .from("mood_headlines")
        .select("symbol,headline_id,title,summary,sentiment,source,link,published_at,captured_at")
        .in("symbol", symbols)
        .order("published_at", { ascending: false, nullsFirst: false });
    if (hlErr) throw hlErr;

    // group headlines per symbol, but respect limitHeadlines
    const groupedHeadlines = new Map();
    for (const h of headlines || []) {
        const list = groupedHeadlines.get(h.symbol) || [];
        if (list.length >= limitHeadlines) continue;
        list.push({
            id: h.headline_id,
            title: h.title,
            sentiment: h.sentiment,
            timestamp: h.published_at || h.captured_at,
            source: h.source || "News",
            summary: h.summary,
            link: h.link || undefined,
        });
        groupedHeadlines.set(h.symbol, list);
    }

    // 3) Build cards in baseInstruments order
    const cards = [];
    for (const base of baseInstruments) {
        const symbol = base.symbol;
        const snapRow = latestSnapBySymbol.get(symbol);
        const hl = groupedHeadlines.get(symbol) || [];

        if (!snapRow && !hl.length) {
            cards.push({
                instrument: base.instrument || symbol,
                symbol,
                sentiment: "neutral",
                sentimentScore: 0.5,
                trend: [],
                headlines: [],
                summary: `${symbol} awaiting first snapshot`,
            });
            continue;
        }

        const snap = snapRow?.snapshot || {};
        const sentiment =
            snap.sentiment ||
            snapRow?.sentiment_label ||
            "neutral";
        const sentimentScore =
            typeof snap.sentimentScore === "number"
                ? snap.sentimentScore
                : Number(snapRow?.sentiment_score ?? 0.5);
        const instrumentName =
            snap.instrument ||
            snapRow?.instrument ||
            base.instrument ||
            symbol;

        cards.push({
            instrument: instrumentName,
            symbol,
            sentiment,
            sentimentScore,
            trend: [], // only fill if returnTrend=true, see below
            headlines: hl,
            summary: snap.summary || "—",
        });
    }

    // 4) Optional: if you ever decide to use trend again
    // do ONE extra query per symbol set, not 1 per symbol
    // only if returnTrend === true
    // (you can wire that in later if needed)

    // 5) KPI counts (cheaper and saner)
    const { count: hlCount, error: hlCountErr } = await sb
        .from("mood_headlines")
        .select("*", { count: "exact", head: true });
    if (hlCountErr) throw hlCountErr;

    const instrumentsCovered = new Set((headlines || []).map((h) => h.symbol)).size;

    const snapshotTs =
        (headlines && headlines[0]?.published_at) || null;

    // 6) Apply limitCards at API level (save frontend extra work)
    const sortedCards = cards
        .filter((c) => c.headlines.length)
        .sort(
            (a, b) =>
                new Date(
                    b.headlines[0]?.timestamp || 0
                ) -
                new Date(
                    a.headlines[0]?.timestamp || 0
                )
        )
        .slice(0, limitCards);

    return {
        instrumentsCovered,
        headlinesIndexed: hlCount ?? 0,
        snapshotTs,
        cards: sortedCards,
    };
}

router.get("/overview", async (req, res) => {
    const nowDay = todayUTC();
    const defaultFrom = new Date(nowDay);
    defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 7);
    const defaultTo = new Date(nowDay);
    defaultTo.setUTCDate(defaultTo.getUTCDate() + 21);

    const start = req.query.from ? new Date(req.query.from) : defaultFrom;
    const end = req.query.to ? new Date(req.query.to) : defaultTo;
    const market = req.query.market || null;
    const impact = req.query.impact || null; // single impact filter if supplied
    const type = req.query.type || null;
    const search = req.query.q || null;
    const symbols = csvOrRepeatable(req.query, "symbols");
    const category = req.query.category || "all";

    // const limitMovers = Number(req.query.limitMovers ?? 5);
    // const limitHeadlines = Number(req.query.limitHeadlines ?? 1);
    // const returnTrend = parseBool(req.query.returnTrend, false);

    const limitMovers = Number(req.query.limitMovers ?? 5);
    const limitHeadlines = Number(req.query.limitHeadlines ?? 1);   // per instrument
    const limitNewsCards = Number(req.query.limitNewsCards ?? 4);   // total cards
    const returnTrend = parseBool(req.query.returnTrend, false);


    // use same BASE_INSTRUMENTS set as news.js for cards
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

    // parallel blocks with partial failure tolerance
    const promises = {
        calendar: calendarSummary({
            from: start.toISOString(),
            to: end.toISOString(),
            market,
            impact,
            type,
            search,
            symbols
        }).catch((e) => ({ __error__: e.message || String(e) })),

        prices: pricesOverview(category, limitMovers).catch((e) => ({ __error__: e.message || String(e) })),

        sentiment: sentimentOverview({ from: start.toISOString(), to: end.toISOString(), symbols }).catch((e) => ({
            __error__: e.message || String(e)
        })),

        // news: newsCards({ limitHeadlines, returnTrend, baseInstruments: BASE_INSTRUMENTS }).catch((e) => ({
        //     __error__: e.message || String(e)
        // }))

        news: newsCards({
            limitHeadlines,
            limitCards: limitNewsCards,
            returnTrend,
            baseInstruments: BASE_INSTRUMENTS,
        }).catch((e) => ({
            __error__: e.message || String(e),
        })),
    };

    const [calendar, prices, sentiment, news] = await Promise.all([
        promises.calendar,
        promises.prices,
        promises.sentiment,
        promises.news
    ]);

    const errors = [];
    for (const [key, val] of Object.entries({ calendar, prices, sentiment, news })) {
        if (val && val.__error__) errors.push({ [key]: val.__error__ });
    }

    const payload = {
        meta: {
            from: toISODate(start),
            to: toISODate(end),
            generatedAt: new Date().toISOString(),
            market,
            category
        },
        kpis: null,
        calendar: calendar && !calendar.__error__
            ? (({ byDate, byImpact, byType, byMarket, symbolsTop }) => ({ byDate, byImpact, byType, byMarket, symbolsTop }))(calendar)
            : null,
        prices: prices && !prices.__error__ ? prices : null,
        news: news && !news.__error__ ? news : null,
        charts: null,
        errors
    };

    const rise = sentiment.trends.rising ?? 0;
    const fall = sentiment.trends.falling ?? 0;
    const flat = sentiment.trends.flat ?? 0;
    const total = rise + fall + flat;
    const sentimentMomentum = total ? Number(((rise - fall) / total * 100).toFixed(1)) : null;


    if (calendar && !calendar.__error__ && prices && !prices.__error__ && news && !news.__error__ && sentiment && !sentiment.__error__) {
        payload.kpis = {
            calendar: { total: calendar.total, impact: calendar.byImpact },
            prices: { tracked: prices.tracked, lastUpdated: prices.snapshotTs },
            // tracked: prices.tracked,
            news: {
                instrumentsCovered: news.instrumentsCovered,
                headlinesIndexed: news.headlinesIndexed,
                snapshotTs: news.snapshotTs
            },
            sentimentMomentum: sentimentMomentum
        };
        payload.charts = {
            eventsByDay: calendar.byDate.map((r) => ({ x: r.date, y: r.count })),
            impactMix: Object.entries(calendar.byImpact).map(([name, value]) => ({
                name: name[0].toUpperCase() + name.slice(1),
                value
            })),
            sentimentHistogram: sentiment.histogram,
            sentimentTrends: sentiment.trends
        };
    }

    if (errors.length) res.status(206);
    res.set("Cache-Control", "public, max-age=10");
    res.json(payload);
});

// Detail (daily): last N daily bars (default 30)
router.get("/detail/daily", async (req, res) => {
    try {
        const symbol = String(req.query.symbol || "").trim().toUpperCase();
        const days = Math.min(Math.max(parseInt(String(req.query.days || "12"), 10) || 12, 1), 365);

        if (!symbol) return res.status(400).json({ error: "symbol_required" });

        // 1) Resolve instrument and exchange
        const { data: inst, error: instErr } = await sb
            .from("instruments")
            .select(
                "id,symbol,name,asset,exchange_id,exchanges:exchanges!instruments_exchange_id_fkey(id,code,name,venue,tz)"
            )
            .eq("symbol", symbol)
            .maybeSingle();

        if (instErr) throw instErr;
        if (!inst) return res.status(404).json({ error: "not_found" });

        // 2) Get last N daily bars (newest first)
        // If your price_bars_1d has only dt,close keep the select minimal.
        // If it also has open/high/low/volume, the select below will work as-is.
        const { data: dailies, error: dErr } = await sb
            .from("price_bars_1d")
            .select("dt, open, high, low, close, volume")
            .eq("instrument_id", inst.id)
            .order("dt", { ascending: false })
            .limit(days);

        if (dErr) throw dErr;

        const dailyRows = (dailies || []).map((r) => ({
            // keep key name `ts` for frontend compatibility, but it's a daily date
            ts: r.dt, // ISO date from DB; fine to pass through
            open: r.open != null ? Number(r.open) : null,
            high: r.high != null ? Number(r.high) : null,
            low: r.low != null ? Number(r.low) : null,
            close: r.close != null ? Number(r.close) : null,
            volume: r.volume != null ? Number(r.volume) : null,
        }));

        // Compute daily change from the newest two dailies
        const [latest, prev] = (dailies || []);
        const lastClose = latest?.close != null ? Number(latest.close) : null;
        const prevClose = prev?.close != null ? Number(prev.close) : null;
        const change =
            lastClose != null && prevClose != null ? Number((lastClose - prevClose).toFixed(4)) : null;
        const change_pct =
            change != null && prevClose
                ? Number(((change / Number(prevClose)) * 100).toFixed(2))
                : null;

        // Respond ascending by date for chart sanity
        dailyRows.reverse();

        res.json({
            symbol: inst.symbol,
            name: inst.name || inst.symbol,
            asset: inst.asset,
            exchange: inst.exchanges?.code ?? null,
            rows: dailyRows,                 // one row per day
            last_close: lastClose,
            prev_close: prevClose,
            change,
            change_pct,
            last_close_dt: latest?.dt ?? null,
        });
    } catch (err) {
        console.error("detail/daily error:", err);
        res.status(500).json({ error: "internal_error", detail: String(err?.message || err) });
    }
});

module.exports = router;
