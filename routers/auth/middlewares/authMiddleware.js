const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || req.headers.Authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const token = header.split(' ')[1];
    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Optional hardening: reject tokens older than last password reset
    const { data: user, error } = await supabase
      .from('app_users')
      .select('id, role, password_updated_at')
      .eq('id', payload.sub)
      .single();

    if (error || !user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const tokenIssuedAtMs = (payload.iat || 0) * 1000;
    const pwdUpdatedAtMs = new Date(user.password_updated_at).getTime();
    if (tokenIssuedAtMs < pwdUpdatedAtMs) {
      return res.status(401).json({
        error: 'Token invalid due to password change. Please log in again.',
      });
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
