const express = require('express');
const {
  login,
  verifyOtp,
  resendOtp,
  requestReset,
  verifyResetOtp,
  completeReset,
  register,
  verifyRegisterOtp,
  resendRegisterOtp,
  googleStartGet,
  googleStartPost,
  // googleCallbackGet,
  logout,          // NEW
  // csrf             // NEW
} = require('./controllers/authcontroller.js');

const {
  // googleStart,
  googleCallback,
} = require('./controllers/authcontroller.js');


const router = express.Router();

// Registration (2-step)
router.post('/register', register);                      // start: send OTP
router.post('/register/verify', verifyRegisterOtp);      // finish: create user
router.post('/register/resend-otp', resendRegisterOtp);  // optional

// Login (2-step)
router.post('/login', login);
router.post('/verify-otp', verifyOtp);
router.post('/resend-otp', resendOtp);

// // Google OAuth -> OTP -> session
// router.get('/google/start', googleStart);
// router.get('/google/callback', googleCallback);

// ========== routes ==========
// router.post("/google/start", googleStartPost);
// router.get("/google/callbackGet", googleCallbackGet);

router.get("/google/start", googleStartGet);
router.post("/google/start", googleStartPost);
router.get("/google/callback", googleCallback);


// Password reset
router.post('/password-reset/request', requestReset);
router.post('/password-reset/verify', verifyResetOtp);
router.post('/password-reset/complete', completeReset);

// Auth cookie utilities
router.post('/logout', logout);  // clears HttpOnly auth cookie + csrf cookie
// router.get('/csrf', csrf);       // returns current csrf token (if you want to bootstrap header)

module.exports = router;
