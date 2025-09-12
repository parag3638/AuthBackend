const express = require('express');
const { register, login, verifyOtp, resendOtp } = require('./controllers/authcontroller.js');
const { requestReset, verifyResetOtp, completeReset } = require('./controllers/authcontroller.js');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/verify-otp', verifyOtp);
router.post('/resend-otp', resendOtp);
router.post('/password-reset/request', requestReset);
router.post('/password-reset/verify', verifyResetOtp);
router.post('/password-reset/complete', completeReset);

module.exports = router;

