import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import chatRoutes from './routes/chat.route.js';

dotenv.config();

const app = express();

// Trust proxy (important for Firebase Cloud Functions)
// Ensures rate limiting uses real client IPs, not Firebase's IP
app.set('trust proxy', 1);

// CORS configuration
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Security headers using Helmet
app.use(helmet());

// HTTP request logging (morgan)
app.use(morgan('dev'));

// JSON body parsing with size limit
app.use(express.json({ limit: '10kb' }));

// GLOBAL rate limiter - protects entire API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 200 requests per IP
  standardHeaders: true,
  legacyHeaders: false,
  // Security logging for rate limit hits
  handler: (req, res, next, options) => {
    console.warn('[SECURITY] Rate limit triggered:', {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      timestamp: new Date().toISOString(),
      limit: '200/15min'
    });
    
    res.status(429).json({
      error: 'Too many requests. Please try again later.',
      code: 'RATE_LIMIT_GLOBAL'
    });
  },
  message: {
    error: 'Too many requests. Please try again later.',
    code: 'RATE_LIMIT_GLOBAL'
  }
});

// STRICT rate limiter specifically for chatbot
const chatLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 30, // only 30 chat messages per IP
  standardHeaders: true,
  legacyHeaders: false,
  // Security logging for rate limit hits
  handler: (req, res, next, options) => {
    console.warn('[SECURITY] Chat rate limit triggered:', {
      ip: req.ip,
      path: req.originalUrl,
      method: req.method,
      timestamp: new Date().toISOString(),
      limit: '30/5min'
    });
    
    res.status(429).json({
      error: 'Chat message limit reached. Please wait a few minutes.',
      code: 'RATE_LIMIT_CHAT',
      retryAfter: '5 minutes'
    });
  },
  message: {
    error: 'Chat message limit reached. Please wait a few minutes.',
    code: 'RATE_LIMIT_CHAT',
    retryAfter: '5 minutes'
  }
});

// Apply GLOBAL limiter to ALL routes first
app.use(apiLimiter);

// Apply STRICT limiter specifically to chat endpoint
// This creates layered protection (global + specific)
app.use('/chat', chatLimiter);

// Routes
app.use('/', chatRoutes);

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Chatbot backend running on port ${PORT}`);
  console.log(`Rate limiting active: Global (200/15min), Chat (30/5min)`);
  console.log(`Security headers enabled via Helmet`);
  console.log(`HTTP request logging enabled via Morgan`);
  console.log(`Security logging active for rate limit events`);
});