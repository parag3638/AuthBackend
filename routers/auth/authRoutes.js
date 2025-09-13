const express = require('express');
const { login, verifyOtp, resendOtp } = require('./controllers/authcontroller.js');
const { requestReset, verifyResetOtp, completeReset } = require('./controllers/authcontroller.js');
const { register, verifyRegisterOtp, resendRegisterOtp, } = require('../../controllers/authcontroller');

const router = express.Router();

// Registration (2-step)
router.post('/register', register);                 // start: send OTP
router.post('/register/verify', verifyRegisterOtp); // finish: create user
router.post('/register/resend-otp', resendRegisterOtp); // optional

// Login (2-step)
router.post('/login', login);
router.post('/verify-otp', verifyOtp);
router.post('/resend-otp', resendOtp);
router.post('/password-reset/request', requestReset);
router.post('/password-reset/verify', verifyResetOtp);
router.post('/password-reset/complete', completeReset);

module.exports = router;
