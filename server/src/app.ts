import crypto from 'node:crypto';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import type { ScanRequest } from '@rfid-attendance/shared';
import { AttendanceService } from './attendance.js';
import { asScanError, ScanError } from './errors.js';
import { safeConfig, type AppConfig } from './config.js';
import type { GoogleSheetsService } from './sheets.js';
import { manilaTimestamp } from './time.js';
import { SetupError, SetupService, setupTokenFromRequest } from './setup.js';

export type CreateAppOptions = { sheets: GoogleSheetsService; config: AppConfig; logger?: boolean; staticDir?: string };

function requestId(req: Request): string {
  const existing = req.header('x-request-id');
  return existing && /^[A-Za-z0-9._-]{1,100}$/.test(existing) ? existing : crypto.randomUUID();
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const attendance = new AttendanceService(options.sheets, options.config);
  const setup = new SetupService(options.sheets, options.config);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: options.config.corsOrigin }));
  app.use((req, _res, next) => {
    req.requestId = requestId(req);
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));
  if (options.logger !== false) app.use(morgan('combined'));
  app.use(rateLimit({
    windowMs: options.config.rateLimitWindowMs,
    limit: options.config.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => {
      const error = new ScanError('RATE_LIMITED', 'Too many requests. Please try again later.', 429, Math.ceil(options.config.rateLimitWindowMs / 1000));
      res.status(429).json(error.toResponse(req.requestId));
    },
  }));

  app.use((req, res, next) => {
    res.setHeader('X-Request-ID', req.requestId);
    next();
  });

  app.get('/api/health', async (req, res) => {
    try {
      await options.sheets.healthCheck();
      res.status(200).json({ success: true, service: 'rfid-attendance-api', timestamp: manilaTimestamp(new Date(), options.config.timezone), googleSheets: 'connected' });
    } catch {
      res.status(503).json({ success: false, requestId: req.requestId, error: { code: 'GOOGLE_SHEETS_UNAVAILABLE', message: 'Google Sheets is unavailable.' } });
    }
  });

  app.get('/api/config', (_req, res) => res.status(200).json(safeConfig(options.config)));

  const scanHandler = async (req: Request, res: Response) => {
    const body = req.body as unknown;
    const validObject = typeof body === 'object' && body !== null && !Array.isArray(body);
    const keys = validObject ? Object.keys(body as object) : [];
    const hasOnlyExpectedKeys = keys.every((key) => key === 'rfidUid' || key === 'source');
    const value = validObject ? body as Partial<ScanRequest> : undefined;
    const scanRequest = hasOnlyExpectedKeys ? { rfidUid: value?.rfidUid ?? '', source: value?.source as ScanRequest['source'] } : { rfidUid: '', source: undefined as unknown as ScanRequest['source'] };
    const result = await attendance.scan(scanRequest, req.requestId);
    if ('error' in result) res.status(statusForError(result.error.code)).json(result);
    else res.status(200).json(result);
  };
  app.post('/api/attendance/scan', scanHandler);
  app.post('/api/scan', scanHandler);

  app.post('/api/setup/unlock', (req, res) => {
    try {
      const result = setup.unlock((req.body as { pin?: unknown } | undefined)?.pin);
      res.status(200).json({ success: true, requestId: req.requestId, ...result });
    } catch (error) { sendSetupError(req, res, error); }
  });

  const lockHandler = (req: Request, res: Response) => {
    try {
      setup.lock(setupTokenFromRequest(req.headers as { authorization?: string; 'x-setup-token'?: string }));
      res.status(200).json({ success: true, requestId: req.requestId });
    } catch (error) { sendSetupError(req, res, error); }
  };
  app.post('/api/setup/lock', lockHandler);

  const cardLookupHandler = async (req: Request, res: Response) => {
    try {
      const rawUid = typeof req.params.rfidUid === 'string' ? req.params.rfidUid : typeof req.query.rfidUid === 'string' ? req.query.rfidUid : '';
      const result = await setup.lookupCard(setupTokenFromRequest(req.headers as { authorization?: string; 'x-setup-token'?: string }), rawUid);
      res.status(200).json({ success: true, requestId: req.requestId, ...result });
    } catch (error) { sendSetupError(req, res, error); }
  };
  app.get('/api/setup/card', cardLookupHandler);
  app.get('/api/setup/card/:rfidUid', cardLookupHandler);
  app.get('/api/setup/cards/:rfidUid', cardLookupHandler);

  const upsertUserHandler = async (req: Request, res: Response) => {
    try {
      const result = await setup.upsertUser(setupTokenFromRequest(req.headers as { authorization?: string; 'x-setup-token'?: string }), req.body);
      res.status(200).json({ success: true, requestId: req.requestId, ...result });
    } catch (error) { sendSetupError(req, res, error); }
  };
  app.post('/api/setup/user', upsertUserHandler);
  app.post('/api/setup/users', upsertUserHandler);

  const errorHandler: ErrorRequestHandler = (error, req, res, _next) => {
    const scanError = error instanceof SyntaxError ? new ScanError('INVALID_SCAN_INPUT', 'Request body must be valid JSON.', 400) : asScanError(error);
    res.status(scanError.status).json(scanError.toResponse(req.requestId));
  };
  app.use(errorHandler);
  if (options.staticDir) {
    app.use(express.static(path.resolve(options.staticDir), { index: 'index.html' }));
    app.get('*', (_req, res) => res.sendFile(path.resolve(options.staticDir!, 'index.html')));
  }
  return app;
}

function statusForError(code: string): number {
  switch (code) {
    case 'UNKNOWN_RFID_CARD': return 404;
    case 'INACTIVE_USER': return 403;
    case 'DUPLICATE_SCAN':
    case 'RATE_LIMITED': return 429;
    case 'ATTENDANCE_ALREADY_COMPLETED':
    case 'ATTENDANCE_DATA_CONFLICT': return 409;
    case 'GOOGLE_SHEETS_UNAVAILABLE': return 503;
    case 'CONFIGURATION_ERROR':
    case 'INTERNAL_SERVER_ERROR': return 500;
    default: return 400;
  }
}

function sendSetupError(req: Request, res: Response, error: unknown): void {
  const setupError = error instanceof SetupError ? error : new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'Setup service is temporarily unavailable.', 503);
  res.status(setupError.status).json(setupError.toResponse(req.requestId));
}

declare global {
  namespace Express {
    interface Request { requestId: string }
  }
}

export { statusForError };
