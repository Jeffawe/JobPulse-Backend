import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jobRoutes from './routes/jobRoute.js';
import authRoutes from './routes/authRoute.js';
import { verifyApiKey } from './middleware/apikey.js';
import { initDB, initApplicationDB } from './db/database.js';
import { addColumns } from './db/database.js';
import helmet from "helmet";
import rateLimit from 'express-rate-limit';

dotenv.config();

const app = express();

app.use(cors()); // Enable CORS
app.use(express.json());
// Middleware
app.use(helmet());

const limiter = rateLimit({
    windowMs: 30 * 60 * 1000, // 30 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
});
app.use(limiter);

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

app.get('/setup', (req, res) => {
    try {
        //initDB();
        initApplicationDB();
        //addColumns()
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
app.use('/api/auth', authRoutes);
app.use('/api/job', jobRoutes);

export default app;
