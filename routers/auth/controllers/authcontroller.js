// controllers/authcontroller.js
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');
const crypto = require('crypto');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h';
const RESEND_FROM = process.env.RESEND_FROM || 'noreply@corelytixai.com';
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined; // e.g. .yourdomain.com

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
const now = () => new Date();
const minutesFromNow = (m) => new Date(Date.now() + m * 60 * 1000);
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit

function signJwt(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function findUserByEmail(email) {
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('email', email)
    .single();
  if (error && error.code !== 'PGRST116') throw error; // ignore "no rows"
  return data || null;
}

async function insertUser({ name, email, password_hash, role = 'user' }) {
  const { data, error } = await supabase
    .from('app_users')
    .insert([{ name, email, password_hash, role }])
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

// Create a hashed OTP row (purpose: 'login' | 'reset')
async function createHashedOtp(user_id, purpose, ttlMinutes = 10) {
  const otp = generateOtp();
  const otp_hash = await bcrypt.hash(otp, 10);
  const { error } = await supabase
    .from('login_otps')
    .insert([{
      user_id,
      otp_hash,
      purpose,
      expires_at: minutesFromNow(ttlMinutes).toISOString(),
    }]);
  if (error) throw error;
  return otp; // plaintext only returned to email it; never stored
}

// Verify & consume latest OTP (single-use)
async function verifyAndConsumeOtp(user_id, otp, purpose) {
  const { data: rec, error } = await supabase
    .from('login_otps')
    .select('*')
    .eq('user_id', user_id)
    .eq('purpose', purpose)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!rec) return { ok: false, reason: 'invalid' };
  if (new Date(rec.expires_at) < now()) return { ok: false, reason: 'expired' };

  // Optional: attempts cap if you added the column
  if (typeof rec.attempts === 'number' && rec.attempts >= 5) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  const isMatch = await bcrypt.compare(otp, rec.otp_hash);

  // Increment attempts regardless of outcome if the column exists
  if (typeof rec.attempts === 'number') {
    await supabase
      .from('login_otps')
      .update({ attempts: rec.attempts + 1 })
      .eq('id', rec.id);
  }

  if (!isMatch) return { ok: false, reason: 'invalid' };

  // Mark consumed
  const { error: updErr } = await supabase
    .from('login_otps')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', rec.id);
  if (updErr) throw updErr;

  return { ok: true };
}

// ──────────────────────────────────────────────────────────────────────────────
// Cookie helpers (HttpOnly JWT + readable CSRF)
// ──────────────────────────────────────────────────────────────────────────────
function secondsFrom(expr) {
  if (typeof expr === 'number') return expr;
  const m = String(expr).trim().match(/^(\d+)\s*([smhd])?$/i);
  if (!m) return 3600; // default 1h
  const n = parseInt(m[1], 10);
  const u = (m[2] || 's').toLowerCase();
  return u === 'h' ? n * 3600 : u === 'm' ? n * 60 : u === 'd' ? n * 86400 : n;
}
const ACCESS_MAX_AGE_S = secondsFrom(JWT_EXPIRES_IN);

function buildAuthCookieOptions(maxAgeSeconds = ACCESS_MAX_AGE_S) {
  return {
    httpOnly: true,
    secure: true,              // HTTPS only
    sameSite: 'none',          // cross-site (Render API <-> Vercel FE)
    path: '/',
    maxAge: maxAgeSeconds * 1000,
    domain: COOKIE_DOMAIN,
  };
}

const csrfCookieOptions = {
  httpOnly: false,             // readable by JS for X-CSRF-Token
  secure: true,
  sameSite: 'none',
  path: '/',
  maxAge: 60 * 60 * 1000,      // 1h
  domain: COOKIE_DOMAIN,
};

function setAuthCookies(res, jwtToken) {
  const csrf = crypto.randomBytes(24).toString('hex');
  res.cookie('access_token', jwtToken, buildAuthCookieOptions());
  res.cookie('csrf_token', csrf, csrfCookieOptions);
}

function clearAuthCookies(res) {
  res.cookie('access_token', '', { ...buildAuthCookieOptions(0), maxAge: 0 });
  res.cookie('csrf_token', '', { ...csrfCookieOptions, maxAge: 0 });
}

// ──────────────────────────────────────────────────────────────────────────────
// Controllers
// ──────────────────────────────────────────────────────────────────────────────

// POST /register  { name, email, password }
exports.register = async (req, res) => {
  try {
    const { name, email: rawEmail, password } = req.body || {};
    if (!name || !rawEmail || !password) {
      return res.status(400).json({ error: 'name, email, password are required' });
    }
    const email = String(rawEmail).trim().toLowerCase();

    // 1) Block if an account already exists
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'User with this email already exists' });

    // 2) Hash password now; generate & hash OTP
    const password_hash = await bcrypt.hash(password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otp_hash = await bcrypt.hash(otp, 10);

    // 3) Upsert into pending_registrations (one pending per email)
    await supabase
      .from('pending_registrations')
      .upsert({
        name,
        email,
        password_hash,
        otp_hash,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10m
        attempts: 0,
        consumed_at: null
      }, { onConflict: 'email' });

    // 4) Email OTP
    await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: 'Verify your email (OTP)',
      html: `<p>Your registration OTP is <strong>${otp}</strong>.</p><p>This code expires in 10 minutes.</p>`
    });

    return res.status(200).json({ message: 'OTP sent to email. Please verify to complete registration.' });
  } catch (err) {
    console.error('Register (start) error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// POST /register/verify  { email, otp }
exports.verifyRegisterOtp = async (req, res) => {
  try {
    const { email: rawEmail, otp } = req.body || {};
    if (!rawEmail || !otp) return res.status(400).json({ error: 'email and otp are required' });
    const email = String(rawEmail).trim().toLowerCase();

    // 1) Fetch pending record
    const { data: pending, error } = await supabase
      .from('pending_registrations')
      .select('*')
      .eq('email', email)
      .is('consumed_at', null)
      .maybeSingle();
    if (error) throw error;

    if (!pending) return res.status(401).json({ error: 'No pending registration or already verified' });
    if (new Date(pending.expires_at) < new Date()) return res.status(401).json({ error: 'OTP expired' });

    // Attempts cap
    if (pending.attempts >= 5) return res.status(429).json({ error: 'Too many attempts' });

    const ok = await bcrypt.compare(otp, pending.otp_hash);
    // bump attempts
    await supabase.from('pending_registrations').update({ attempts: pending.attempts + 1 }).eq('id', pending.id);

    if (!ok) return res.status(401).json({ error: 'Invalid OTP' });

    // 2) Create user, then mark pending consumed
    const existing = await findUserByEmail(email);
    if (existing) {
      // Race: someone created already — just consume and return conflict
      await supabase.from('pending_registrations').update({ consumed_at: new Date().toISOString() }).eq('id', pending.id);
      return res.status(409).json({ error: 'User with this email already exists' });
    }

    const { data: userRow, error: insErr } = await supabase
      .from('app_users')
      .insert([{
        name: pending.name,
        email,
        password_hash: pending.password_hash,
        role: 'user'
      }])
      .select('*')
      .single();
    if (insErr) throw insErr;

    await supabase.from('pending_registrations').update({ consumed_at: new Date().toISOString() }).eq('id', pending.id);

    // Auto-login after verify: set cookies (HttpOnly JWT + csrf)
    const token = signJwt(userRow);
    setAuthCookies(res, token);

    return res.status(201).json({
      message: 'Registration completed',
      user: { id: userRow.id, name: userRow.name, email: userRow.email, role: userRow.role }
    });
  } catch (e) {
    console.error('verifyRegisterOtp error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

// POST /register/resend-otp  { email }
exports.resendRegisterOtp = async (req, res) => {
  try {
    const { email: rawEmail } = req.body || {};
    if (!rawEmail) return res.status(400).json({ error: 'email is required' });
    const email = String(rawEmail).trim().toLowerCase();

    // If a user already exists, block
    const existing = await findUserByEmail(email);
    if (existing) return res.status(409).json({ error: 'User with this email already exists' });

    // Ensure there is a pending row (create if missing)
    const { data: pending } = await supabase
      .from('pending_registrations')
      .select('id')
      .eq('email', email)
      .maybeSingle();

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const otp_hash = await bcrypt.hash(otp, 10);

    if (!pending) {
      await supabase.from('pending_registrations').insert([{
        name: email.split('@')[0],
        email,
        password_hash: '$pending$', // placeholder if they didn't start correctly
        otp_hash,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      }]);
    } else {
      await supabase.from('pending_registrations').update({
        otp_hash,
        attempts: 0,
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        consumed_at: null
      }).eq('email', email);
    }

    await resend.emails.send({
      from: RESEND_FROM,
      to: email,
      subject: 'Verify your email (OTP)',
      html: `<p>Your registration OTP is <strong>${otp}</strong>.</p><p>This code expires in 10 minutes.</p>`
    });

    return res.status(200).json({ message: 'OTP resent' });
  } catch (e) {
    console.error('resendRegisterOtp error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};


// POST /login  { email, password }
// → Sends OTP (purpose='login'); token issued after /verify-otp
exports.login = async (req, res) => {
  try {
    let { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }
    email = String(email).trim();

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or user does not exist' });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid password' });

    // OTP MFA for ALL users
    const otp = await createHashedOtp(user.id, 'login', 10);

    // Send via Resend
    try {
      await resend.emails.send({
        from: RESEND_FROM,
        to: user.email,
        subject: 'Your OTP Code',
        html: `<p>Your OTP Code is: <strong>${otp}</strong></p><p>This code expires in 10 minutes.</p>`
      });
    } catch (mailErr) {
      console.error('Resend send error:', mailErr);
      return res.status(500).json({ error: 'Login ok, but failed to send OTP' });
    }

    return res.status(200).json({ message: 'OTP sent to email. Please verify to complete login.' });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// POST /verify-otp  { email, otp }
// → Issues JWT via HttpOnly cookie after successful OTP verification
exports.verifyOtp = async (req, res) => {
  try {
    let { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });
    email = String(email).trim();

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email' });

    const v = await verifyAndConsumeOtp(user.id, otp, 'login');
    if (!v.ok) {
      const msg =
        v.reason === 'expired' ? 'OTP expired' :
          v.reason === 'too_many_attempts' ? 'Too many attempts' :
            'Invalid OTP';
      return res.status(401).json({ error: msg });
    }

    const token = signJwt(user);
    // Set HttpOnly access_token + readable csrf_token; do not return token in body
    setAuthCookies(res, token);
    return res.status(200).json({ message: 'Login successful' });
  } catch (err) {
    console.error('Verify OTP error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// POST /resend-otp  { email }
exports.resendOtp = async (req, res) => {
  try {
    let { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });
    email = String(email).trim();

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const otp = await createHashedOtp(user.id, 'login', 10);

    try {
      await resend.emails.send({
        from: RESEND_FROM,
        to: user.email,
        subject: 'Your OTP Code',
        html: `<p>Your OTP Code is: <strong>${otp}</strong></p><p>This code expires in 10 minutes.</p>`
      });
    } catch (mailErr) {
      console.error('Resend resend error:', mailErr);
      return res.status(500).json({ error: 'Failed to send OTP' });
    }

    return res.status(200).json({ message: 'OTP resent' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ──────────────────────────────────────────────────────────────────────────────
/** Password Reset via Email OTP (same mechanism, purpose='reset') */
// ──────────────────────────────────────────────────────────────────────────────

// POST /password-reset/request  { email }
exports.requestReset = async (req, res) => {
  try {
    let { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'email is required' });
    email = String(email).trim();

    const user = await findUserByEmail(email);

    // Do not reveal existence
    if (user) {
      const otp = await createHashedOtp(user.id, 'reset', 10);
      await resend.emails.send({
        from: RESEND_FROM,
        to: email,
        subject: 'Password Reset OTP',
        html: `<p>Your password reset code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`
      });
    }

    return res.status(200).json({ message: 'If that email exists, an OTP has been sent.' });
  } catch (e) {
    console.error('requestReset error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

// POST /password-reset/verify  { email, otp }
// → returns a short-lived reset_token (JWT) for setting a new password
exports.verifyResetOtp = async (req, res) => {
  try {
    let { email, otp } = req.body || {};
    if (!email || !otp) return res.status(400).json({ error: 'email and otp are required' });
    email = String(email).trim();

    const user = await findUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid email or OTP' });

    const v = await verifyAndConsumeOtp(user.id, otp, 'reset');
    if (!v.ok) {
      const msg =
        v.reason === 'expired' ? 'OTP expired' :
          v.reason === 'too_many_attempts' ? 'Too many attempts' :
            'Invalid OTP';
      return res.status(401).json({ error: msg });
    }

    const reset_token = jwt.sign(
      { sub: user.id, purpose: 'password_reset' },
      JWT_SECRET,
      { expiresIn: '15m' }
    );
    return res.status(200).json({ reset_token, message: 'OTP verified' });
  } catch (e) {
    console.error('verifyResetOtp error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

// POST /password-reset/complete  { reset_token, new_password }
exports.completeReset = async (req, res) => {
  try {
    const { reset_token, new_password } = req.body || {};
    if (!reset_token || !new_password) {
      return res.status(400).json({ error: 'reset_token and new_password are required' });
    }

    let payload;
    try {
      payload = jwt.verify(reset_token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired reset token' });
    }
    if (payload.purpose !== 'password_reset') {
      return res.status(401).json({ error: 'Invalid reset token purpose' });
    }

    const password_hash = await bcrypt.hash(new_password, 10);

    const { error: updErr } = await supabase
      .from('app_users')
      .update({
        password_hash,
        password_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', payload.sub);
    if (updErr) throw updErr;

    return res.status(200).json({ message: 'Password updated. Please log in again.' });
  } catch (e) {
    console.error('completeReset error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

// ──────────────────────────────────────────────────────────────────────────────
// Logout (clears cookies)  POST /logout
// ──────────────────────────────────────────────────────────────────────────────
exports.logout = async (_req, res) => {
  try {
    clearAuthCookies(res);
    return res.status(204).end();
  } catch (e) {
    console.error('logout error', e);
    return res.status(500).json({ error: 'Server error' });
  }
};

// Optional: expose current CSRF (if you want a bootstrap endpoint) GET /csrf
exports.csrf = async (req, res) => {
  try {
    const csrf = req.cookies?.csrf_token || '';
    return res.status(200).json({ csrfToken: csrf });
  } catch (e) {
    return res.status(200).json({ csrfToken: '' });
  }
};
