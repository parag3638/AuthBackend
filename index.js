const express = require('express');
const app = express();
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');

dotenv.config();
const port = process.env.PORT || 9000;

const auth = require('./routers/auth/middlewares/authMiddleware');
const authRoutes = require('./routers/auth/authRoutes');
const authorizeRoles = require('./routers/auth/middlewares/roleMiddlewares');

// Ensure req.secure is accurate behind proxies (Render)
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

// Routes
app.use('/api/auth/', authRoutes);

app.get('/', (req, res) => {
    res.send('MFA Auth Working!');
});

app.get('/me', auth, (req, res) => {
    console.log("User:", req.user);
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
