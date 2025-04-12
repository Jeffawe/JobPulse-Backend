import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import jobRoutes from './routes/jobRoute.js';
import authRoutes from './routes/authRoute.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

//app.use('/api/jobs', jobRoutes);
app.use('/auth', authRoutes);
app.use('/api/job', jobRoutes);

export default app;
