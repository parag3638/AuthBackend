
const { createClient } = require('@supabase/supabase-js');
const express = require("express");
const router = express.Router();

const {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
    process.exit(1);
}

// IMPORTANT: service role key is powerful. Keep this server-only.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'market_data' },
});

// ----------------- Helpers -----------------

function normalizeNumber(x) {
    if (x === null || x === undefined) return null;
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}

function getInstrumentFilter(categoryRaw) {
    const category = String(categoryRaw || 'nifty').toLowerCase();
    const allowed = new Set(['all', 'nifty', 'crypto', 'forex']);
    const cat = allowed.has(category) ? category : 'nifty';

    const apply = (query) => {
        if (cat === 'all') {
            return query.eq('active', true);
        }
        if (cat === 'nifty') {
            // NSE index + equities
            return query
                .eq('active', true)
                .in('asset', ['index', 'equity'])
                .eq('exchanges.code', 'NSE'); // requires !inner join
        }
        if (cat === 'crypto') {
            return query.eq('active', true).eq('asset', 'crypto');
        }
        if (cat === 'forex') {
            return query.eq('active', true).eq('asset', 'forex');
        }
        return query.eq('active', true);
    };

    return { category: cat, apply };
}

async function fetchLatestBar(instrumentId) {
    const { data, error } = await supabase
        .from('price_bars_1m')
        .select('open,high,low,close,volume,ts')
        .eq('instrument_id', instrumentId)
        .order('ts', { ascending: false })
        .limit(1)
        .maybeSingle();

    if (error) throw error;
    return data || null;
}

function toCSV(rows, headersOverride = []) {
    const headers =
        Array.isArray(headersOverride) && headersOverride.length
            ? headersOverride
            : rows?.length
                ? Object.keys(rows[0])
                : [];
    if (!headers.length) return '';
    const escapeCell = (value) => {
        const str = value == null ? '' : String(value);
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const lines = [
        headers.join(','),
        ...(rows || []).map((row) => headers.map((h) => escapeCell(row[h])).join(',')),
    ];
    return lines.join('\n');
}

// // Fetch last 2 daily bars and compute daily change
// async function fetchDailyChange(instrumentId) {
//     const { data, error } = await supabase
//         .from('price_bars_1d')
//         .select('dt, close')
//         .eq('instrument_id', instrumentId)
//         .order('dt', { ascending: false })
//         .limit(2);

//     if (error) throw error;

//     const [latest, prev] = data || [];
//     const lastClose = latest?.close != null ? Number(latest.close) : null;
//     const prevClose = prev?.close != null ? Number(prev.close) : null;

//     if (lastClose == null || prevClose == null) {
//         return { lastClose, prevClose, change: null, change_pct: null, last_dt: latest?.dt || null };
//     }

//     const change = lastClose - prevClose;
//     const change_pct = prevClose !== 0 ? (change / prevClose) * 100 : null;

//     return { lastClose, prevClose, change, change_pct, last_dt: latest.dt };
// }


// Get yesterday's official close (prev trading day) from 1D,
// and compare it to the latest intraday price (1m bar).
async function fetchDailyChangeIntraday(instrumentId) {
    // Today's date (YYYY-MM-DD) in UTC to match your dt column format
    const today = new Date().toISOString().slice(0, 10);

    // 1) Previous day's official close (strictly < today)
    const { data: prevRows, error: prevErr } = await supabase
        .from('price_bars_1d')
        .select('dt, close')
        .eq('instrument_id', instrumentId)
        .lt('dt', today)
        .order('dt', { ascending: false })
        .limit(1);

    if (prevErr) throw prevErr;
    const prevClose = prevRows?.[0]?.close != null ? Number(prevRows[0].close) : null;
    const prevDt = prevRows?.[0]?.dt ?? null;

    // 2) Latest price (from your 1m/real-time aggregation)
    const bar = await fetchLatestBar(instrumentId);
    const lastPrice = bar?.close != null ? Number(bar.close) : null;
    const lastTs = bar?.ts ?? null;

    if (lastPrice == null || prevClose == null) {
        // Fallback: use two most recent DISTINCT daily closes
        const { data: dailies, error: dErr } = await supabase
            .from('price_bars_1d')
            .select('dt, close')
            .eq('instrument_id', instrumentId)
            .order('dt', { ascending: false })
            .limit(3); // grab a few and dedupe by dt

        if (dErr) throw dErr;

        const unique = [];
        const seen = new Set();
        for (const r of dailies || []) {
            if (!seen.has(r.dt)) {
                seen.add(r.dt);
                unique.push(r);
            }
            if (unique.length === 2) break;
        }

        const latest = unique[0];
        const prev = unique[1];

        const lastClose = latest?.close != null ? Number(latest.close) : null;
        const prevClose2 = prev?.close != null ? Number(prev.close) : null;

        if (lastClose == null || prevClose2 == null) {
            return {
                lastPrice,
                prevClose,
                change: null,
                change_pct: null,
                last_dt: latest?.dt ?? null,
                basis: 'fallback-none',
            };
        }

        const change = lastClose - prevClose2;
        const change_pct = prevClose2 !== 0 ? (change / prevClose2) * 100 : null;

        return {
            lastPrice: lastClose,
            prevClose: prevClose2,
            change,
            change_pct,
            last_dt: latest.dt,
            basis: 'two-distinct-daily-closes',
        };
    }

    // Primary path: intraday change = LTP (1m) - yesterday's close (1d)
    const change = lastPrice - prevClose;
    const change_pct = prevClose !== 0 ? (change / prevClose) * 100 : null;

    return {
        lastPrice,
        prevClose,
        change,
        change_pct,
        last_dt: prevDt,       // basis day for the comparison
        last_ts: lastTs,       // timestamp for the latest price
        basis: 'ltp-vs-prevClose',
    };
}



async function buildSnapshotData(rawCategory) {
    const { category, apply } = getInstrumentFilter(rawCategory);

    let query = supabase
        .from('instruments')
        .select(
            'id,symbol,name,asset,exchange_id,exchanges:exchanges!instruments_exchange_id_fkey(id,code,name,venue,tz)'
        )
        .order('symbol', { ascending: true });

    query = apply(query);

    const { data: instruments, error: instErr } = await query;
    if (instErr) throw instErr;

    if (!instruments || instruments.length === 0) {
        return { category, items: [] };
    }

    const items = await Promise.all(
        instruments.map(async (inst) => {
            // const [bar, daily] = await Promise.all([
            //     fetchLatestBar(inst.id),
            //     fetchDailyChange(inst.id),
            // ]);

            const [bar, daily] = await Promise.all([
                fetchLatestBar(inst.id),
                fetchDailyChangeIntraday(inst.id),
            ]);


            // return {
            //     symbol: inst.symbol,
            //     name: inst.name || inst.symbol,
            //     asset: inst.asset,
            //     exchange: inst.exchanges?.code ?? null,
            //     last_price: normalizeNumber(bar?.close),
            //     last_updated: bar?.ts ?? null,
            //     last_close: daily.lastClose,
            //     prev_close: daily.prevClose,
            //     change: daily.change,
            //     change_pct: daily.change_pct,
            //     last_close_dt: daily.last_dt,
            // };

            return {
                symbol: inst.symbol,
                name: inst.name || inst.symbol,
                asset: inst.asset,
                exchange: inst.exchanges?.code ?? null,
                last_price: normalizeNumber(bar?.close),      // LTP
                last_updated: bar?.ts ?? null,
                last_close: daily.prevClose,                  // yesterday's official close
                prev_close: daily.prevClose,                  // keep for clarity or remove
                change: daily.change,
                change_pct: daily.change_pct,
                last_close_dt: daily.last_dt,                 // prev-close date
                // optional debug:
                // basis: daily.basis,
            };
        })
    );

    return { category, items };
}


// ----------------- Routes -----------------

// Snapshot: latest close per instrument in a bucket
router.get('/snapshot', async (req, res) => {
    try {
        const { category: rawCategory } = req.query;
        const { category, items } = await buildSnapshotData(rawCategory);
        res.json({ category, count: items.length, items });
    } catch (err) {
        console.error('snapshot error:', err);
        res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
    }
});

// Snapshot download (CSV)
router.get('/snapshot.csv', async (req, res) => {
    try {
        const { category: rawCategory } = req.query;
        const { category, items } = await buildSnapshotData(rawCategory);

        const headers = [
            'category',
            'symbol',
            'name',
            'asset',
            'exchange',
            'last_price',
            'last_updated',
            'last_close',
            'prev_close',
            'change',
            'change_pct',
            'last_close_dt',
        ];

        const rows = items.map((item) => ({
            category,
            symbol: item.symbol,
            name: item.name,
            asset: item.asset,
            exchange: item.exchange,
            last_price: item.last_price,
            last_updated: item.last_updated,
            last_close: item.last_close,
            prev_close: item.prev_close,
            change: item.change,
            change_pct: item.change_pct,
            last_close_dt: item.last_close_dt,
        }));

        const csv = toCSV(rows, headers);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="prices-snapshot.csv"');
        res.status(200).send(csv);
    } catch (err) {
        console.error('snapshot.csv error:', err);
        res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
    }
});

// Detail: last 50 1m bars for sparkline
router.get('/detail', async (req, res) => {
    try {
        const symbol = String(req.query.symbol || '').trim().toUpperCase();
        if (!symbol) return res.status(400).json({ error: 'symbol_required' });

        // 1️⃣ Fetch instrument + exchange info
        const { data: inst, error: instErr } = await supabase
            .from('instruments')
            .select(
                'id,symbol,name,asset,exchange_id,exchanges:exchanges!instruments_exchange_id_fkey(id,code,name,venue,tz)'
            )
            .eq('symbol', symbol)
            .maybeSingle();

        if (instErr) throw instErr;
        if (!inst) return res.status(404).json({ error: 'not_found' });

        // 2️⃣ Fetch last 50 1m bars for sparkline
        const { data: bars, error: barsErr } = await supabase
            .from('price_bars_1m')
            .select('ts,open,high,low,close,volume')
            .eq('instrument_id', inst.id)
            .order('ts', { ascending: false })
            .limit(50);

        if (barsErr) throw barsErr;

        // 3️⃣ Fetch daily change (last 2 daily bars)
        const { data: dailies, error: dailyErr } = await supabase
            .from('price_bars_1d')
            .select('dt, close')
            .eq('instrument_id', inst.id)
            .order('dt', { ascending: false })
            .limit(2);

        if (dailyErr) throw dailyErr;

        const [latest, prev] = dailies || [];
        const lastClose = latest?.close != null ? Number(latest.close) : null;
        const prevClose = prev?.close != null ? Number(prev.close) : null;
        const change = lastClose != null && prevClose != null ? lastClose - prevClose : null;
        const change_pct =
            change != null && prevClose
                ? Number(((change / prevClose) * 100).toFixed(2))
                : null;

        // 4️⃣ Respond
        res.json({
            symbol: inst.symbol,
            name: inst.name || inst.symbol,
            asset: inst.asset,
            exchange: inst.exchanges?.code ?? null,
            rows: (bars || []).map((r) => ({
                ts: r.ts,
                open: Number(r.open),
                high: Number(r.high),
                low: Number(r.low),
                close: Number(r.close),
                volume: r.volume != null ? Number(r.volume) : null,
            })),
            // daily-change block
            last_close: lastClose,
            prev_close: prevClose,
            change,
            change_pct,
            last_close_dt: latest?.dt ?? null,
        });
    } catch (err) {
        console.error('detail error:', err);
        res.status(500).json({ error: 'internal_error', detail: String(err?.message || err) });
    }
});


module.exports = router;
