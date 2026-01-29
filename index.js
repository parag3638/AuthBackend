const express = require('express');
const app = express();
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { createClient } = require("@supabase/supabase-js");

const helmet = require("helmet");
const morgan = require("morgan");

dotenv.config();
const port = process.env.PORT || 9000;

const intakeRoutes = require("./routers/doc/intake");
const auth = require('./routers/auth/middlewares/authMiddleware');
const authRoutes = require('./routers/auth/authRoutes');
const doctor = require("./routers/doc/doctor");
const templates = require("./routers/templates/template");
const instrumentPrices = require("./routers/instrumentPrices/prices");
const news = require("./routers/news/news");
const calendar = require("./routers/calendar/calendar");
const finDash = require("./routers/finDash/dashboard");
const vectorAI = require("./routers/vectorshift/VectorAI");

const createRequireAuth = require("./routers/whitecarrot/auth/auth");
const createCandidateRouter = require("./routers/whitecarrot/candidate/candidate");
const createRecruiterRouter = require("./routers/whitecarrot/recruiter/recruiter");

// Trust proxy for secure cookies behind Render/NGINX
app.set('trust proxy', 1);

const allowedOrigins = [
    'http://localhost:3000', // common FE dev port
    'http://localhost:9000',
    'https://vectorshift-bazinga.vercel.app/',
    'https://whitecarrot-two.vercel.app',
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


// Routes
app.use('/api/auth/', authRoutes);

app.use("/intake", intakeRoutes);

// app.use("/doctor", auth, doctor);
app.use('/doctor', doctor);

// app.use('/prices', auth, instrumentPrices);
app.use('/prices', instrumentPrices);

// app.use('/mood', auth, news);
app.use('/mood', news);

// app.use('/calendar', auth, calendar);
app.use('/calendar', calendar);

// app.use('/finance', auth, finDash);
app.use('/finance', finDash);

// app.use("/vectorshift", auth, vectorAI);
app.use("/vectorshift", vectorAI);

app.get('/', (req, res) => {
    res.send('MFA Auth Working!');
});

// app.use("/templates", auth, templates);
app.use("/templates", templates);

// app.get('/me', auth, (req, res) => {
//     res.json({ user: req.user });
// });


const supabaseTouch = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  db: { schema: "whitecarrot" },
});

const requireAuth = createRequireAuth(supabaseTouch);
app.use("/api/public", createCandidateRouter({ supabase: supabaseTouch }));
app.use("/api/recruiter", createRecruiterRouter({ supabase: supabaseTouch, requireAuth }));


app.get('/me', (req, res) => {
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
