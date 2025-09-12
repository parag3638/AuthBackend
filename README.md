# AuthBackend
Common MFA Auth

# Next Up:
Refresh tokens with rotation.
Change UserRole to Admin via API


---

# 🔐 MFA Auth API (Supabase + Resend + JWT)

A secure authentication API built with **Node.js / Express**, **Supabase** (Postgres), and **Resend**.

Features include:

* User **registration** (bcrypt password hashing)
* **Login with MFA (OTP)** via email
* **JWT**-based authentication for protected routes
* **Password reset** via OTP + short-lived reset token
* Role support (`user` / `admin`)
* Supabase as the DB, Resend for sending OTP emails

Runs on **PORT 9000** by default.

---

## ⚙️ Tech Stack

* **Node.js / Express**
* **Supabase Postgres** (`@supabase/supabase-js`)
* **Resend** for transactional emails
* **bcrypt** for hashing passwords and OTPs
* **jsonwebtoken** for access & reset tokens

---

## 🚀 Setup

### 1. Clone & install

```bash
npm install
```

### 2. Configure `.env`

```ini
PORT=9000

# Supabase (service role key from Project Settings → API)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# Resend
RESEND_API_KEY=...
RESEND_FROM=noreply@yourdomain.com

# JWT
JWT_SECRET=<long-random-secret>
JWT_EXPIRES_IN=1h

# CORS (comma-separated)
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
```

Generate a strong secret:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 3. Database schema (Supabase SQL)

```sql
create extension if not exists citext;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email citext not null unique,
  password_hash text not null,
  role text not null default 'user',
  password_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop table if exists login_otps cascade;

create table login_otps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  otp_hash text not null,
  purpose text not null,               -- 'login' or 'reset'
  expires_at timestamptz not null,
  consumed_at timestamptz,
  attempts smallint not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists idx_login_otps_user_purpose
  on login_otps (user_id, purpose, created_at desc);
```

---

## 📡 Run

```bash
npm run dev    # or: node index.js
# API: http://localhost:9000
```

---

## 🌐 API Routes

Base path: **`/api/auth`**

### Register

`POST /register`

```json
{ "name": "Parag", "email": "parag@example.com", "password": "Test@12345" }
```

### Login → sends OTP

`POST /login`

```json
{ "email": "parag@example.com", "password": "Test@12345" }
```

### Resend OTP

`POST /resend-otp`

```json
{ "email": "parag@example.com" }
```

### Verify OTP → returns JWT

`POST /verify-otp`

```json
{ "email": "parag@example.com", "otp": "123456" }
```

Response:

```json
{ "message": "Login successful", "token": "<JWT>" }
```

Use in headers:

```
Authorization: Bearer <JWT>
```

---

### Password Reset: Request OTP

`POST /password-reset/request`

```json
{ "email": "parag@example.com" }
```

### Password Reset: Verify OTP → reset\_token

`POST /password-reset/verify`

```json
{ "email": "parag@example.com", "otp": "654321" }
```

Response:

```json
{ "reset_token": "<short-lived JWT>", "message": "OTP verified" }
```

### Password Reset: Complete

`POST /password-reset/complete`

```json
{ "reset_token": "<reset_token>", "new_password": "New@12345" }
```

---

### Protected route example

`GET /me`
Headers: `Authorization: Bearer <JWT>`

Response:

```json
{ "user": { "sub": "...", "email": "parag@example.com", "role": "user" } }
```

---

## ⏲️ Expiry Rules

| Token / Code             | Where stored               | Expires in                 | Notes                                             |
| ------------------------ | -------------------------- | -------------------------- | ------------------------------------------------- |
| **Access JWT**           | Client only (Bearer token) | `JWT_EXPIRES_IN` (e.g. 1h) | Signed with `JWT_SECRET`                          |
| **Login OTP**            | `login_otps.otp_hash`      | \~10 minutes               | Single-use; marked consumed                       |
| **Password Reset OTP**   | `login_otps.otp_hash`      | \~10 minutes               | Same table, purpose='reset'                       |
| **Password Reset Token** | Short-lived JWT            | \~15 minutes               | Returned after reset OTP verify                   |
| **Old JWTs after reset** | N/A                        | Immediately                | Middleware rejects if `iat < password_updated_at` |

---

## 🔒 Security Notes

* Passwords & OTPs are **bcrypt hashed** (never stored in plaintext).
* OTPs are **single-use** (`consumed_at` set after verification).
* **Short TTLs** reduce attack window.
* Old JWTs are **invalidated** after password reset.
* Use **service role key** only on server, never on client.
* Rate-limit login & OTP endpoints.

---

## 🧪 Quick Test

```bash
# Register
curl -X POST http://localhost:9000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name":"Parag","email":"parag@example.com","password":"Test@12345"}'

# Login -> OTP email
curl -X POST http://localhost:9000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"parag@example.com","password":"Test@12345"}'

# Verify OTP
curl -X POST http://localhost:9000/api/auth/verify-otp \
  -H "Content-Type: application/json" \
  -d '{"email":"parag@example.com","otp":"123456"}'
```

---