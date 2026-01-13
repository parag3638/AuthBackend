const express = require("express");
const rateLimit = require("express-rate-limit");
const router = express.Router();
const OpenAI = require("openai");
const NODE_CATALOG = require("./nodeCatalog.js");

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});


// simple rate limit (tune later)
const sseLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 requests/min per IP
});


function buildSysPrompt({ nodeCatalog, includeActions, maxOutputTokens }) {
    const catalogJson = JSON.stringify(nodeCatalog, null, 2);

    // The bot should not hallucinate node types. Force it to only use known ones.
    return [
        "You are VectorShift Pipeline Copilot.",
        "You help users build pipelines using ONLY the nodes in the provided catalog.",
        "You can:",
        "(1) Explain what each node does and how to connect them.",
        "(2) Provide sample pipelines and explain them.",
        "(3) If user asks to 'build' a pipeline, respond with a JSON plan (actions) using available node types.",
        "",
        "Hard rules:",
        "- Do NOT invent node types or handles not in the catalog.",
        "- If something is missing, say what's missing and propose the closest alternative.",
        "- Be concise. Prefer steps and small diagrams.",
        `- Keep answers under ~${maxOutputTokens} tokens; use 1-3 sentences unless user asks for detail.`,
        "",
        includeActions
            ? [
                "When asked to CREATE/BUILD a pipeline, output TWO parts:",
                "1) A short human explanation.",
                "2) A final line: ```COPILOT_ACTIONS:<json>``` where <json> matches:",
                "{",
                '  "message": string,',
                '  "actions": [',
                '    { "type": "ADD_NODE", "id": string, "nodeType": string, "position": { "x": number, "y": number }, "data": object },',
                '    { "type": "ADD_EDGE", "id": string, "source": string, "sourceHandle": string, "target": string, "targetHandle": string },',
                '    { "type": "UPDATE_NODE", "id": string, "data": object }',
                "  ]",
                "}",
                "Only include COPILOT_ACTIONS when user asked to build/create/apply.",
            ].join("\n")
            : "If user asks to build, just describe steps (no JSON).",
        "",
        "NODE CATALOG (authoritative):",
        catalogJson
    ].join("\n");
}

function buildContextSummary({ nodes, edges }) {
    if (!nodes?.length) return "No current pipeline present.";
    const nodeTypes = nodes.map((n) => `${n.id}:${n.type}`).join(", ");
    const edgePairs = (edges || [])
        .map((e) => `${e.source}${e.sourceHandle ? `(${e.sourceHandle})` : ""} -> ${e.target}${e.targetHandle ? `(${e.targetHandle})` : ""}`)
        .join(", ");

    return [
        "CURRENT PIPELINE CONTEXT:",
        `Nodes (${nodes.length}): ${nodeTypes}`,
        `Edges (${(edges || []).length}): ${edgePairs || "none"}`,
    ].join("\n");
}

function buildGraph(nodes, edges) {
    const nodeIds = new Set();
    const adj = new Map();

    (nodes || []).forEach((node) => {
        const id = String(node.id);
        nodeIds.add(id);
        if (!adj.has(id)) adj.set(id, []);
    });

    (edges || []).forEach((edge) => {
        const source = String(edge.source);
        const target = String(edge.target);
        nodeIds.add(source);
        nodeIds.add(target);
        if (!adj.has(source)) adj.set(source, []);
        if (!adj.has(target)) adj.set(target, []);
        adj.get(source).push(target);
    });

    return { nodeIds, adj, edgeCount: (edges || []).length };
}

function isDag({ nodeIds, adj }) {
    const indegree = new Map();
    nodeIds.forEach((id) => indegree.set(id, 0));

    nodeIds.forEach((id) => {
        const neighbors = adj.get(id) || [];
        neighbors.forEach((to) => {
            indegree.set(to, (indegree.get(to) || 0) + 1);
        });
    });

    const queue = [];
    indegree.forEach((deg, id) => {
        if (deg === 0) queue.push(id);
    });

    let visited = 0;
    while (queue.length) {
        const id = queue.shift();
        visited += 1;
        const neighbors = adj.get(id) || [];
        neighbors.forEach((to) => {
            const next = (indegree.get(to) || 0) - 1;
            indegree.set(to, next);
            if (next === 0) queue.push(to);
        });
    }

    return visited === nodeIds.size;
}

router.post("/pipelines/parse", (req, res) => {
    const { nodes = [], edges = [] } = req.body || {};
    if (!Array.isArray(nodes) || !Array.isArray(edges)) {
        return res.status(400).json({ error: "nodes and edges must be arrays" });
    }

    const graph = buildGraph(nodes, edges);
    return res.json({
        num_nodes: graph.nodeIds.size,
        num_edges: graph.edgeCount,
        is_dag: isDag(graph),
    });
});

router.post("/agent", sseLimiter, async (req, res) => {
    try {
        const {
            history = [],
            user_message,
            // optional: pass these from frontend if you want the bot to reference current pipeline
            nodes = [],
            edges = [],
            // optional: allow your UI to request structured actions
            include_actions = true,
            // optional: cap response length
            max_output_tokens = 200,
        } = req.body || {};

        if (!user_message || typeof user_message !== "string") {
            return res.status(400).json({ error: "user_message is required" });
        }

        const safeMaxOutputTokens = Number.isFinite(Number(max_output_tokens))
            ? Math.max(32, Math.min(800, Number(max_output_tokens)))
            : 200;

        const sysPrompt = buildSysPrompt({
            nodeCatalog: NODE_CATALOG,
            includeActions: Boolean(include_actions),
            maxOutputTokens: safeMaxOutputTokens,
        });

        const pipelineContext = buildContextSummary({ nodes, edges });

        const messages = [
            { role: "system", content: sysPrompt },
            { role: "system", content: pipelineContext },
            ...history.map((t) => ({
                role: t.role === "user" ? "user" : "assistant",
                content: String(t.content || "").slice(0, 4000),
            })),
            { role: "user", content: user_message.slice(0, 4000) },
        ];

        // Call OpenAI (non-streaming)
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                stream: false,
                temperature: 0.3,
                max_tokens: safeMaxOutputTokens,
                messages,
            }),
        });

        if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            return res.status(resp.status).json({ error: text || resp.statusText });
        }

        const data = await resp.json();
        const fullText = data?.choices?.[0]?.message?.content || "";

        let actionsPayload = null;
        let actionsError = null;
        const marker = "COPILOT_ACTIONS:";
        const idx = fullText.lastIndexOf(marker);
        if (idx !== -1) {
            const maybe = fullText.slice(idx + marker.length).trim();
            const jsonText = maybe.replace(/^```/, "").replace(/```$/, "").trim();
            try {
                actionsPayload = JSON.parse(jsonText);
            } catch (e) {
                actionsError = "Failed to parse COPILOT_ACTIONS JSON";
            }
        }

        res.setHeader("Content-Type", "application/json");
        return res.json({
            text: fullText,
            actions: actionsPayload,
            actions_error: actionsError,
        });
    } catch (err) {
        try {
            res.status(500).json({ error: err?.message || "error" });
        } catch { }
    }
});

module.exports = router;
