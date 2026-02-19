import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import chatRoutes from './routes/chat.route.js';

dotenv.config();

const app = express();

// ✅ CORS — MUST COME FIRST
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// JSON body parsing
app.use(express.json());

// Routes
app.use('/', chatRoutes);

const PORT = 3000;

app.listen(PORT, () => {
  console.log(`Chatbot backend running on port ${PORT}`);
});