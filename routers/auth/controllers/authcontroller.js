const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
dotenv.config();
const usersFilePath = path.join(__dirname, '../users.json');
const SECRET_FILE = path.join(__dirname, '../secrets.json');


// ✅ Login API (Using `users.json`)
const login = async (req, res) => {
    const { email, password } = req.body;

    try {
        console.log('Checking user in users.json...');

        let users = getUsers();

        // **Case-insensitive email lookup**
        const user = users.find(user => user.email.toLowerCase() === email.toLowerCase());

        if (!user) {
            return res.status(401).json({ error: 'Invalid email or user does not exist' });
        }

        // **Verify password**
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid password' });
        }

        // **Generate JWT token**
        const token = jwt.sign(
            { id: user.id, role: user.role, email: user.email, name: user.name },
            process.env.JWT_SECRET,
            { expiresIn: '1h' }
        );

        if(user.role === 'admin'){
            return res.status(200).json({ token, message: "Login successful. Admin" });
        }

        // **Generate OTP**
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // **Store token & OTP in `secret.json`**
        let secrets = readSecrets();
        secrets[email.toLowerCase()] = { token, otp };

        console.log("✅ Token & OTP stored successfully.");

        // **Send OTP via Email**
        try {
            await resend.emails.send({
                from: "noreply@corelytixai.com", // ✅ Now using your domain!
                to: email,
                subject: "Your OTP Code",
                html: `<p>Your OTP Code is: <strong>${otp}</strong></p>`,
            });
            writeSecrets(secrets);
            console.log("✅ OTP Sent Successfully to:", email);
        } catch (emailError) {
            console.error("❌ Error sending OTP:", emailError);
            return res.status(500).json({ error: "Login successful, but failed to send OTP." });
        }

        return res.status(200).json({message: "Login successful. OTP sent to email." });

    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Server error' });
    }
};


// ✅ **Register User Function**
const register = async (req, res) => {
    const { name, email, password, role = 'user' } = req.body;

    try {
        console.log('Registering user in users.json...');

        let users = getUsers();

        // **Check if user already exists (case-insensitive email check)**
        if (users.some(user => user.email.toLowerCase() === email.toLowerCase())) {
            return res.status(400).json({ error: 'User with this email already exists' });
        }

        // **Hash password**
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // **Create new user**
        const newUser = {
            id: users.length + 1,
            name,
            email,
            password_hash: hashedPassword,
            role,
            In_Stamp: new Date().toISOString() // Store timestamp
        };

        users.push(newUser);
        saveUsers(users);

        res.json({ message: 'User registered successfully', user: { name, email, role } });
        console.log(`User ${email} registered successfully.`);
    } catch (error) {
        console.error('Registration error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
};



// Helper function to read users from JSON file
function getUsers() {
    if (!fs.existsSync(usersFilePath)) {
        fs.writeFileSync(usersFilePath, JSON.stringify([])); // Create file if not exists
    }
    return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
}


// Helper function to read users from JSON file
function getUsers() {
    if (!fs.existsSync(usersFilePath)) {
        fs.writeFileSync(usersFilePath, JSON.stringify([])); // Create file if missing
    }
    return JSON.parse(fs.readFileSync(usersFilePath, 'utf8'));
}

// Helper function to save users to JSON file
function saveUsers(users) {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2)); // Pretty print JSON
}


/**
 * Utility function to read and write to `secret.json`
 */
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


module.exports = { login, register };


const USERS_FILE = path.join(__dirname, "users.json"); // Users database file

// **Helper function to get users from users.json**
function getUsers() {
    if (!fs.existsSync(usersFilePath)) {
        console.error("❌ users.json not found!");
        return [];
    }
    return JSON.parse(fs.readFileSync(usersFilePath, "utf8"));
}

//hello123
//admin123