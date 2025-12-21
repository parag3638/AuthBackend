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


function buildSysPrompt({ nodeCatalog, includeActions }) {
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
        } = req.body || {};

        if (!user_message || typeof user_message !== "string") {
            return res.status(400).json({ error: "user_message is required" });
        }

        // SSE headers
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");

        const sysPrompt = buildSysPrompt({
            nodeCatalog: NODE_CATALOG,
            includeActions: Boolean(include_actions),
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

        // SSE helper
        const send = (event, data) => {
            res.write(`event: ${event}\n`);
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

        // Call OpenAI streaming
        const resp = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                stream: true,
                temperature: 0.3,
                messages,
            }),
        });

        if (!resp.ok || !resp.body) {
            const text = await resp.text().catch(() => "");
            send("error", { error: text || resp.statusText });
            res.end();
            return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();

        let fullText = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            for (const line of chunk.split("\n")) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;

                const payload = trimmed.slice(5).trim();
                if (payload === "[DONE]") {
                    // Try to extract COPILOT_ACTIONS JSON if present
                    const marker = "COPILOT_ACTIONS:";
                    const idx = fullText.lastIndexOf(marker);
                    if (idx !== -1) {
                        const maybe = fullText.slice(idx + marker.length).trim();
                        // maybe is within ``` ... ```
                        const jsonText = maybe.replace(/^```/, "").replace(/```$/, "").trim();
                        try {
                            const actionsPayload = JSON.parse(jsonText);
                            send("actions", actionsPayload);
                        } catch (e) {
                            // if parsing fails, still finish normally
                            send("actions_error", { error: "Failed to parse COPILOT_ACTIONS JSON" });
                        }
                    }
                    send("done", {});
                    res.end();
                    return;
                }

                try {
                    const json = JSON.parse(payload);
                    const delta = json?.choices?.[0]?.delta?.content || "";
                    if (delta) {
                        fullText += delta;
                        send("token", { text: delta });
                    }
                } catch {
                    // ignore keepalives / partial lines
                }
            }
        }

        send("done", {});
        res.end();
    } catch (err) {
        try {
            res.write(`event: error\ndata: ${JSON.stringify({ error: err?.message || "error" })}\n\n`);
            res.end();
        } catch { }
    }
});

module.exports = router;
