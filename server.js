import 'dotenv/config';
import express from 'express';
import { createClient } from '@supabase/supabase-js';

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

app.use(express.json());

// ── 4. Health-check route ──────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    message: '🚀 Razorpay Payment Recovery backend is running.',
    supabase: 'connected',
    timestamp: new Date().toISOString(),
  });
});

// ── 5. Start the server ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅  Server running at http://localhost:${PORT}`);
  console.log(`    Supabase URL : ${SUPABASE_URL}`);
});

export { supabase };
