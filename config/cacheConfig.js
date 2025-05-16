import Redis from 'ioredis';
import dotenv from 'dotenv';
dotenv.config();

// Cache durations in seconds
export const CACHE_DURATIONS = {
    USER_PROFILE: 1800,       // 30 minutes
    DISCORD_WEBHOOK: 3600,   // 1 hour
    OTHER: 3600,             // 1 hour
};

// Create Redis client
const createRedisClient = () => {
    const redisConfig = {
        retryStrategy: (times) => {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
        password: process.env.REDIS_PASSWORD
    };

    if (process.env.NODE_ENV === 'development') {
        redisConfig.host = '127.0.0.1';
        redisConfig.port = 6379;
    } else {
        redisConfig.host = process.env.REDIS_HOST;
        redisConfig.port = process.env.REDIS_PORT || 6379;
        redisConfig.tls = process.env.REDIS_TLS === 'true' ? {} : undefined;
    }

    return new Redis(redisConfig);
};

// Create Redis client
const redisClient = createRedisClient();

// Event handlers
redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err);
});

redisClient.on('connect', () => {
    console.log('Redis Client Connected');
});

// Cache utility functions
export const cacheUtils = {
    // Set cache with expiry
    setCache: async (key, data, duration) => {
        try {
            await redisClient.setex(key, duration, JSON.stringify(data));
        } catch (error) {
            console.error('Cache Set Error:', error);
        }
    },

    // Get cached data
    getCache: async (key) => {
        try {
            const data = await redisClient.get(key);
            return data ? JSON.parse(data) : null;
        } catch (error) {
            console.error('Cache Get Error:', error);
            return null;
        }
    },

    // Get multiple keys from cache
    mget: async (keys) => {
        if (!keys || !keys.length) return [];

        try {
            const results = await redisClient.mget(keys);
            return results.map(result => {
                if (!result) return null;
                try {
                    return JSON.parse(result);
                } catch (parseError) {
                    console.error('Parse error for cached value:', parseError);
                    return null;
                }
            });
        } catch (error) {
            console.error('Cache MGET Error:', error);
            return [];
        }
    },

    // Delete specific cache
    deleteCache: async (key) => {
        try {
            await redisClient.del(key);
        } catch (error) {
            console.error('Cache Delete Error:', error);
        }
    },

    clearCachePattern: async (pattern) => {
        try {
            const keys = await redisClient.keys(pattern);
            if (keys.length > 0) {
                await redisClient.del(keys);
            }
        } catch (error) {
            console.error('Cache Clear Pattern Error:', error);
        }
    },

    clearAllCache: async () => {
        try {
            const keys = await redisClient.keys('*');
            if (keys.length > 0) {
                await redisClient.del(keys);
                console.log(`Cleared ${keys.length} Redis keys.`);
            }
        } catch (error) {
            console.error('Error clearing all Redis cache:', error);
        }
    }
};

// Optional: Middleware for route caching
export const cacheMiddleware = (duration) => {
    return async (req, res, next) => {
        if (process.env.NODE_ENV === 'test') return next();

        try {
            const key = `route:${req.originalUrl}`;
            const cachedData = await cacheUtils.getCache(key);

            if (cachedData) {
                return res.json(cachedData);
            }

            // Store the original res.json function
            const originalJson = res.json;
            res.json = function (data) {
                cacheUtils.setCache(key, data, duration);
                return originalJson.call(this, data);
            };

            next();
        } catch (error) {
            console.error('Cache Middleware Error:', error);
            next();
        }
    };
};


export default redisClient;