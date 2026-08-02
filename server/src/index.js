import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import factsRouter from './routes/facts.js';
import suggestionsRouter from './routes/suggestions.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/facts', factsRouter);
app.use('/api/suggestions', suggestionsRouter);

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
