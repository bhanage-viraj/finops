import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import { databaseStatus } from './config/db.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createAdminRouter } from './routes/admin.routes.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createDocumentRouter } from './routes/documents.routes.js';

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

export function createApp(env, options = {}) {
  const app = express();
  app.set('trust proxy', 1);

  if (options.requireDatabase) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      const apiPath = req.path.startsWith('/auth')
        || req.path.startsWith('/admin')
        || req.path.startsWith('/documents');
      if (apiPath && databaseStatus() !== 'connected') {
        res.status(503).json({ error: 'The database is not connected, so this action cannot be saved.' });
        return;
      }
      next();
    });
  }

  app.use(helmet());
  const allowedOrigins = [...new Set([env.clientUrl, 'http://localhost:5173'])];
  app.use(cors({ origin: allowedOrigins }));
  app.use(morgan('dev', {
    skip: (req) => req.path.startsWith('/auth/zoho/callback'),
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 2000,
    standardHeaders: true,
    legacyHeaders: false,
  }));

  // Public on purpose. Login arrives in M1; this only reports process and database state.
  app.get('/health', (req, res) => {
    const database = databaseStatus();
    const status = database === 'connected' ? 'ok' : 'unavailable';
    res.status(database === 'connected' ? 200 : 503).json({ status, database });
  });

  app.use('/auth', createAuthRouter(env));
  app.use('/admin', createAdminRouter(env));
  app.use('/documents', createDocumentRouter(env));

  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const apiPath = req.path === '/health'
        || req.path.startsWith('/auth')
        || req.path.startsWith('/admin')
        || req.path.startsWith('/documents');
      if (apiPath) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);
  return app;
}
