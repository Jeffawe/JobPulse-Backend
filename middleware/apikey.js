import dotenv from 'dotenv';
dotenv.config();

export const verifyApiKey = (req, res, next) => {
    const apiKey = req.header('api-key');
    if (apiKey !== process.env.API_KEY) {
        return res.status(403).json({ message: 'Forbidden: Invalid API Key' });
    }
    next();
};