import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import apiRouter from './src/api/routes.js';

// ── 1. Validate required environment variables ─────────────────────────────
const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error(
    '❌  Missing required environment variables.\n' +
    '    Ensure SUPABASE_URL and SUPABASE_SECRET_KEY are set in your .env file.'
  );
  process.exit(1);
}

// ── 2. Create the Supabase client ──────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ── 3. Create the Express app ──────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

// Minimal CORS middleware
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// ── 4. Health-check & API routes ───────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: '🚀 Razorpay Payment Recovery backend is running.',
    supabase: 'connected',
    timestamp: new Date().toISOString(),
  });
});

app.use('/api', apiRouter);

// ── 5. Dashboard static files ──────────────────────────────────────────────
// Serves the judge-facing dashboard at GET /dashboard/
// Deliberately mounted AFTER the API routes so API routes take priority.
// Uses relative paths inside the HTML/JS so there is no conflict with other routes.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/dashboard', express.static(path.join(__dirname, 'public', 'dashboard')));

// ── 6. Start the server (when executed directly) ───────────────────────────
const isMainModule = Boolean(
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
);

let server;
if (isMainModule && process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    console.log(`✅  Server running at http://localhost:${PORT}`);
    console.log(`    Supabase URL : ${SUPABASE_URL}`);
  });
}

export { app, server, supabase };
