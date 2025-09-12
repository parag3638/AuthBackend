const express = require('express');
const router = express.Router();
const { Resend } = require("resend");
const fs = require('fs');
const path = require('path');

require("dotenv").config();
const resend = new Resend(process.env.RESEND_API_KEY);
const SECRET_FILE = path.join(__dirname, '../auth/secrets.json');


module.exports = function () {

    router.post("/verify-otp", (req, res) => {
        const { email, otp } = req.body;
        let secrets = readSecrets();

        if (!secrets[email] || secrets[email].otp !== otp) {
            return res.status(400).json({ message: "Invalid OTP. Please try again." });
        }

        const token = secrets[email].token;
        delete secrets[email]; // Remove the entry after successful verification
        writeSecrets(secrets);

        return res.status(200).json({ message: "OTP verified successfully", token });
    });

    return router;
}


// 1️⃣ Read secret.json safely
function readSecrets() {
    try {
        if (!fs.existsSync(SECRET_FILE)) {
            fs.writeFileSync(SECRET_FILE, JSON.stringify({})); // Create file if missing
        }
        return JSON.parse(fs.readFileSync(SECRET_FILE, "utf8"));
    } catch (error) {
        console.error("Error reading secret.json:", error);
        return {}; // Return empty object on error
    }
}

// 2️⃣ Write data safely to secret.json
function writeSecrets(data) {
    try {
        fs.writeFileSync(SECRET_FILE, JSON.stringify(data, null, 2)); // Pretty print JSON
    } catch (error) {
        console.error("Error writing to secret.json:", error);
    }
}

// 3️⃣ Clear user entry from secret.json (after OTP verification)
function clearSecret(email) {
    let secrets = readSecrets();
    if (secrets[email]) {
        delete secrets[email]; // Remove user data
        writeSecrets(secrets);
    }
}