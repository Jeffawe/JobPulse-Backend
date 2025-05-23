import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jobRoutes from './routes/jobRoute.js';
import authRoutes from './routes/authRoute.js';
import googleRoutes from './routes/googleRoute.js';
import { verifyApiKey } from './middleware/apikey.js';
import { initDB, initApplicationDB, initTestUserLimitsDB } from './db/database.js';
import { addColumns, deleteDB } from './db/database.js';
import helmet from "helmet";
import rateLimit from 'express-rate-limit';
import { cacheUtils } from './config/cacheConfig.js';

dotenv.config();

const app = express();

app.use(cors()); // Enable CORS
app.use(express.json());
// Middleware
app.use(helmet());

const limiter = rateLimit({
    windowMs: 30 * 60 * 1000, // 30 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: 'Too many requests from this IP, please try again later'
});

app.use(limiter);

app.use('/api/job/google', rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 attempts per hour
    message: 'Too many login attempts, please try again later'
}));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'api-key', 'userid'],
    credentials: true,
    exposedHeaders: ['*']
}));

if (!process.env.API_KEY) {
    console.error('Missing required environment variables.');
    process.exit(1);
}

app.get('/', (req, res) => {
    res.send('Welcome to the Job Pulse API');
});

// app.get('/delete', (req, res) => {
//     try {
//         deleteDB();
//         res.status(200).json({
//             status: 'success',
//             message: 'Database deleted successfully'
//         });
//     } catch (err) {
//         console.log(err)
//     }
// })

app.get('/clear', (req, res) => {
    try {
        cacheUtils.clearAllCache();
        res.status(200).json({
            status: 'success',
            message: 'Cleared all cache successfully'
        });
    } catch (err) {
        console.log(err)
    }
})

app.get('/setup', (req, res) => {
    try {
        initDB();
        initApplicationDB();
        initTestUserLimitsDB();
        // addColumns()
        res.status(200).json({
            status: 'success',
            message: 'Database initialized successfully'
        });
    } catch (err) {
        console.log(err)
    }
})

app.get('/health', (req, res) => {
    sendAlert("App health was checked. it's up and healthy")
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

//app.use('/api/jobs', jobRoutes);
app.use('/api/auth', verifyApiKey, authRoutes);
app.use('/api/job', verifyApiKey, jobRoutes);
app.use('/api/google', googleRoutes);

export default app;
