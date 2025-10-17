// middleware/auth.js
const jwt = require("jsonwebtoken");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function auth(req, res, next) {
  try {
    // Let CORS preflight pass without auth/CSRF checks
    if (req.method === "OPTIONS") return next();

    // Prefer JWT from HttpOnly cookie; fallback to Bearer header
    let token = req.cookies?.access_token;
    if (!token) {
      const header = req.headers.authorization || req.headers.Authorization || "";
      if (typeof header === "string" && header.startsWith("Bearer ")) {
        token = header.slice(7);
      }
    }

    // Redirect if no token found
    if (!token) {
      return res.redirect(`${process.env.APP_PUBLIC_URL}/vaultx/dashboard`);
    }

    // Verify token
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.redirect(`${process.env.APP_PUBLIC_URL}/vaultx/dashboard`);
    }

    // Check user still valid
    const { data: user, error } = await supabase
      .from("app_users")
      .select("id, role, password_updated_at")
      .eq("id", payload.sub)
      .single();

    if (error || !user) {
      return res.redirect(`${process.env.APP_PUBLIC_URL}/vaultx/dashboard`);
    }

    if (user.password_updated_at) {
      const tokenIssuedAtMs = (payload.iat || 0) * 1000;
      const pwdUpdatedAtMs = new Date(user.password_updated_at).getTime();
      const SKEW_MS = 120000; // 2 min tolerance
      if (pwdUpdatedAtMs - tokenIssuedAtMs > SKEW_MS) {
        return res.redirect(`${process.env.APP_PUBLIC_URL}/vaultx/dashboard`);
      }
    }

    // Attach safe user payload
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
    return res.redirect(`${process.env.APP_PUBLIC_URL}/vaultx/dashboard`);
  }
}

module.exports = auth;
