// middleware/auth.js (drop-in)
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function auth(req, res, next) {
  try {
    // Let CORS preflight pass without auth/CSRF checks
    if (req.method === 'OPTIONS') return next();

    // CSRF check for unsafe methods: header must match cookie
    if (UNSAFE_METHODS.has(req.method)) {
      const csrfHeader = req.get('X-CSRF-Token');
      const csrfCookie = req.cookies?.csrf_token;
      if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
        return res.status(403).json({ error: 'CSRF validation failed' });
      }
    }

    // Prefer JWT from HttpOnly cookie; fallback to Bearer header
    let token = req.cookies?.access_token;
    if (!token) {
      const header = req.headers.authorization || req.headers.Authorization || '';
      if (typeof header === 'string' && header.startsWith('Bearer ')) {
        token = header.slice(7);
      }
    }
    if (!token) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Verify token
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Optional hardening: invalidate tokens issued before last password change
    const { data: user, error } = await supabase
      .from('app_users')
      .select('id, role, password_updated_at')
      .eq('id', payload.sub)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    // if (user.password_updated_at) {
    //   const tokenIssuedAtMs = (payload.iat || 0) * 1000;
    //   const pwdUpdatedAtMs = new Date(user.password_updated_at).getTime();
    //   if (tokenIssuedAtMs < pwdUpdatedAtMs) {
    //     return res.status(401).json({
    //       error: 'Token invalid due to password change. Please log in again.',
    //     });
    //   }
    // }

    if (user.password_updated_at) {
      const tokenIssuedAtMs = (payload.iat || 0) * 1000;
      const pwdUpdatedAtMs = new Date(user.password_updated_at).getTime();
      const SKEW_MS = 120000; // 2 minutes tolerance
      if (pwdUpdatedAtMs - tokenIssuedAtMs > SKEW_MS) {
        return res.status(401).json({
          error: 'Token invalid due to password change. Please log in again.',
        });
      }
    }

    // Attach safe user payload to request
    req.user = {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      role: user.role,
      iat: payload.iat,
    };

    return next();
  } catch (e) {
    console.error('auth middleware error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = auth;
