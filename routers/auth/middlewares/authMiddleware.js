// middleware/auth.js
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function auth(req, res, next) {
  try {
    if (req.method === "OPTIONS") return next();

    let token = req.cookies?.access_token;
    if (!token) {
      const header = req.headers.authorization || req.headers.Authorization || "";
      if (typeof header === "string" && header.startsWith("Bearer ")) {
        token = header.slice(7);
      }
    }

    if (!token) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "unauthenticated" });
    }

    const { data: user, error } = await supabase
      .from("app_users")
      .select("id, role, password_updated_at")
      .eq("id", payload.sub)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: "unauthenticated" });
    }

    if (user.password_updated_at) {
      const tokenIssuedAtMs = (payload.iat || 0) * 1000;
      const pwdUpdatedAtMs = new Date(user.password_updated_at).getTime();
      const SKEW_MS = 120000;
      if (pwdUpdatedAtMs - tokenIssuedAtMs > SKEW_MS) {
        return res.status(401).json({ error: "unauthenticated" });
      }
    }

    req.user = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      role: user.role,
      iat: payload.iat,
    };

    return next();
  } catch (e) {
    console.error("auth middleware error:", e);
    return res.status(401).json({ error: "unauthenticated" });
  }
}

module.exports = auth;
