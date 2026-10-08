// EngineerOS - AI-Powered Software Engineering Intelligence Platform
import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import './db.js';
import { router as authRouter } from './routes/auth.js';
import { router as projectsRouter } from './routes/projects.js';
import { router as requirementsRouter } from './routes/requirements.js';
import { router as organizationsRouter } from './routes/organizations.js';
import { router as workRouter } from './routes/work.js';
import { router as intelRouter } from './routes/intel.js';
import { router as githubRouter } from './routes/github.js';
import umlRouter from './routes/uml.js';
import { initPostgres } from './pg.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = express();

// Initialize PostgreSQL connection pool if configured
initPostgres().catch(err => console.warn('[PostgreSQL Init]', err.message));

app.use(express.json({ limit: '10mb' }));
app.use(express.static(join(root, 'public')));
app.use('/OS', express.static(join(root, 'public')));

const apiRouter = express.Router();
apiRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'EngineerOS', version: '1.0.0' }));
apiRouter.use('/auth', authRouter);
apiRouter.use('/organizations', organizationsRouter);
apiRouter.use('/projects/:pid/requirements', requirementsRouter);
apiRouter.use('/projects/:pid/github', githubRouter);
apiRouter.use('/projects/:pid', workRouter);
apiRouter.use('/projects/:pid', intelRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/uml', umlRouter);

app.use('/api', apiRouter);
app.use('/OS/api', apiRouter);

// Return JSON 404 for any unmatched API endpoints so they never return HTML
app.all(['/api/*', '/OS/api/*'], (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

// Any non-API path falls through to the single-page client.
app.get('*', (_req, res) => res.sendFile(join(root, 'public', 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('[EngineerOS]', err);
  res.status(500).json({ error: err.message || 'Something went wrong on the server.' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`EngineerOS running at http://localhost:${port} (or http://127.0.0.1:${port})`);
});
