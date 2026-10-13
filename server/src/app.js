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
import { createFollowUpRouter } from './routes/followUp.routes.js';
import { createImportsRouter } from './routes/imports.routes.js';
import { createPaymentsRouter } from './routes/payments.routes.js';

const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');

function wantsHtmlPage(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const accept = String(req.get('accept') || '');
  return accept.includes('text/html');
}

function sendSpa(res) {
  res.sendFile(path.join(clientDist, 'index.html'));
}

export function createApp(env, options = {}) {
  const app = express();
  app.set('trust proxy', 1);

  if (options.requireDatabase) {
    app.use((req, res, next) => {
      if (req.path === '/health') return next();
      if (wantsHtmlPage(req)) return next();
      const apiPath = req.path.startsWith('/auth')
        || req.path.startsWith('/admin')
        || req.path.startsWith('/documents')
        || req.path.startsWith('/follow-up')
        || req.path.startsWith('/payments')
        || req.path.startsWith('/imports');
      if (apiPath && databaseStatus() !== 'connected') {
        res.status(503).json({ error: 'The database is not connected, so this action cannot be saved.' });
        return;
      }
      next();
    });
  }

  // Receipt photos are drawn from blob URLs. The default image rule blocks those.
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        'img-src': ["'self'", 'data:', 'blob:'],
        'frame-src': ["'self'", 'blob:'],
      },
    },
  }));
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

  // Browser refresh of app routes asks for HTML. Serve the site, not the API JSON.
  if (fs.existsSync(clientDist)) {
    app.use((req, res, next) => {
      if (!wantsHtmlPage(req)) return next();
      if (
        req.path === '/documents'
        || req.path.startsWith('/documents/')
        || req.path === '/follow-up'
        || req.path.startsWith('/follow-up/')
        || req.path === '/payments'
        || req.path.startsWith('/payments/')
      ) {
        sendSpa(res);
        return;
      }
      next();
    });
  }

  app.use('/documents', createDocumentRouter(env));
  app.use('/follow-up', createFollowUpRouter(env));
  app.use('/payments', createPaymentsRouter(env));
  app.use('/imports', createImportsRouter(env));

  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (!wantsHtmlPage(req)) return next();
      const apiPath = req.path === '/health'
        || req.path.startsWith('/auth')
        || req.path.startsWith('/admin')
        || req.path.startsWith('/documents')
        || req.path.startsWith('/follow-up')
        || req.path.startsWith('/payments')
        || req.path.startsWith('/imports');
      if (apiPath) return next();
      sendSpa(res);
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(errorHandler);
  return app;
}
