const express = require('express');
const app = express();
const dotenv = require('dotenv');
const cors = require('cors');
const bodyParser = require("body-parser");

dotenv.config();


const authRoutes = require('./routers/auth/authRoutes')();
const mail = require('./routers/common/mail.js')();



const allowedOrigins = [
    'http://localhost:9000',
    ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
];

app.use(
    cors({
        origin: function (origin, callback) {
            // Allow requests with no origin like mobile apps or curl requests
            if (!origin) return callback(null, true);
            if (allowedOrigins.indexOf(origin) === -1) {
                const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
                return callback(new Error(msg), false);
            }
            return callback(null, true);
        }
    })
);


app.set('view engine', 'ejs');
app.use(bodyParser.json());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth/', authRoutes);
app.use('/mail/', mail);


app.get('/', (req, res) => {
    res.send('MFA Auth Working!');
});

app.listen(9000, () => {
    console.log('ON PORT 9000');
});
