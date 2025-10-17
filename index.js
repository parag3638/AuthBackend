const express = require('express');
const app = express();
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const helmet = require("helmet");
const morgan = require("morgan");

dotenv.config();
const port = process.env.PORT || 9000;

const intakeRoutes = require("./routers/doc/intake");
const auth = require('./routers/auth/middlewares/authMiddleware');
const authRoutes = require('./routers/auth/authRoutes');
const doctor = require("./routers/doc/doctor");
const templates = require("./routers/templates/template");

// Trust proxy for secure cookies behind Render/NGINX
app.set('trust proxy', 1);

const allowedOrigins = [
    'http://localhost:3000', // common FE dev port
    'http://localhost:9000',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : [])
];

function corsOriginDelegate(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
    return callback(new Error(msg), false);
}

const corsOptions = {
    origin: corsOriginDelegate,
    credentials: true, // allow cookies/credentials
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
};

// CORS (incl. preflight)
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.set('view engine', 'ejs');
app.use(cookieParser()); // <-- required for reading HttpOnly cookie in auth middleware
app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// basics
app.use(helmet());
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));


// Seeds a readable CSRF cookie for GET/HEAD (client echoes it in X-CSRF-Token)
function seedCsrf(req, res, next) {
    // Only seed on safe methods; your auth middleware enforces on unsafe ones.
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.cookies?.csrf_token) {
        const token = crypto.randomBytes(24).toString('hex');
        res.cookie('csrf_token', token, {
            httpOnly: false,          // must be readable by FE to mirror into header
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            path: '/',
            maxAge: 1000 * 60 * 60 * 8, // 8h
        });
        // (Optional) also expose via header to make first fetch simpler
        res.setHeader('X-CSRF-Token', token);
    }
    next();
}

app.use(seedCsrf);


// Routes
app.use('/api/auth/', authRoutes);

app.use("/intake", intakeRoutes);

app.use("/doctor", auth, doctor);
// app.use('/doctor', auth, doctor);

app.get('/', (req, res) => {
    res.send('MFA Auth Working!');
});

app.use("/templates", auth, templates);

app.get('/me', auth, (req, res) => {
    res.json({ user: req.user });
});

// Optional: surface CORS errors as JSON instead of generic HTML
app.use((err, req, res, next) => {
    if (err && /CORS policy/i.test(err.message)) {
        return res.status(403).json({ error: err.message });
    }
    return next(err);
});

app.listen(port, () => {
    console.log(`Listening on port ${port}`);
});
