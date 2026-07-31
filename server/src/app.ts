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
import { AdminError, AdminService } from './admin.js';
import { uploadPhotoDataUrl } from './photo-storage.js';

export type CreateAppOptions = { sheets: GoogleSheetsService; config: AppConfig; logger?: boolean; staticDir?: string };

function requestId(req: Request): string {
  const existing = req.header('x-request-id');
  return existing && /^[A-Za-z0-9._-]{1,100}$/.test(existing) ? existing : crypto.randomUUID();
}

export function createApp(options: CreateAppOptions): express.Express {
  const app = express();
  const attendance = new AttendanceService(options.sheets, options.config);
  const setup = new SetupService(options.sheets, options.config);
  const admin = new AdminService(options.sheets, options.config);

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: options.config.corsOrigin }));
  app.use((req, _res, next) => {
    req.requestId = requestId(req);
    next();
  });
  app.use(express.json({ limit: '2mb', strict: true }));
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

  app.get('/api/attendance', async (req, res) => {
    try {
      const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : new Intl.DateTimeFormat('en-CA', { timeZone: options.config.timezone }).format(new Date());
      res.json({ success: true, date, attendance: await admin.attendance(date), fetchedAt: manilaTimestamp(new Date(), options.config.timezone) });
    } catch { res.status(503).json({ success: false, requestId: req.requestId, error: { code: 'GOOGLE_SHEETS_UNAVAILABLE', message: 'Attendance data is temporarily unavailable.' } }); }
  });

  app.post('/api/admin/unlock', (req, res) => {
    try { const result = admin.unlock((req.body as { pin?: unknown } | undefined)?.pin); res.setHeader('Set-Cookie', `rfid_admin=${result.token}; Max-Age=${(options.config.adminSessionMinutes ?? 15) * 60}; Path=/; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`); res.json({ success: true, requestId: req.requestId, expiresAt: result.expiresAt }); } catch (error) { sendAdminError(req, res, error); }
  });
  app.get('/api/admin/session', (req, res) => { try { const token = cookieValue(req, 'rfid_admin'); requireAdmin(req); res.json({ success: true, requestId: req.requestId, expiresAt: new Date(Number(token!.split('.')[0])).toISOString() }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/lock', (req, res) => { res.setHeader('Set-Cookie', 'rfid_admin=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict'); res.json({ success: true, requestId: req.requestId }); });
  const requireAdmin = (req: Request) => admin.verify(cookieValue(req, 'rfid_admin'));
  app.get('/api/admin/users', async (req, res) => { try { requireAdmin(req); res.json({ success: true, users: await admin.users() }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/users', async (req, res) => { try { requireAdmin(req); res.json({ success: true, ...(await admin.saveUser(req.body)) }); } catch (error) { sendAdminError(req, res, error); } });
  app.patch('/api/admin/users/:userId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, ...(await admin.saveUser(req.body, req.params.userId)) }); } catch (error) { sendAdminError(req, res, error); } });
  app.delete('/api/admin/users/:userId', async (req, res) => { try { requireAdmin(req); await admin.deleteUser(req.params.userId); res.json({ success: true, requestId: req.requestId }); } catch (error) { sendAdminError(req, res, error); } });
  app.get('/api/admin/attendance', async (req, res) => { try { requireAdmin(req); const date = typeof req.query.date === 'string' ? req.query.date : new Intl.DateTimeFormat('en-CA', { timeZone: options.config.timezone }).format(new Date()); res.json({ success: true, date, attendance: await admin.attendance(date, true), fetchedAt: manilaTimestamp(new Date(), options.config.timezone) }); } catch (error) { sendAdminError(req, res, error); } });
  app.patch('/api/admin/attendance/:attendanceId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, attendance: await admin.updateAttendance(req.params.attendanceId, req.body) }); } catch (error) { sendAdminError(req, res, error); } });
  app.delete('/api/admin/attendance/:attendanceId', async (req, res) => { try { requireAdmin(req); const date = typeof req.query.date === 'string' ? req.query.date : ''; await admin.deleteAttendance(req.params.attendanceId, date); res.json({ success: true, requestId: req.requestId }); } catch (error) { sendAdminError(req, res, error); } });
  app.get('/api/admin/payroll/profiles', async (req, res) => { try { requireAdmin(req); res.json({ success: true, profiles: await admin.payrollProfiles() }); } catch (error) { sendAdminError(req, res, error); } });
  app.put('/api/admin/payroll/profiles/:profileId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, profile: await admin.savePayrollProfile({ ...(req.body as object), profileId: req.params.profileId }) }); } catch (error) { sendAdminError(req, res, error); } });
  app.get('/api/admin/payroll/cutoffs', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.cutoffPayroll() }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/payroll/cutoffs', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.saveCutoffPayroll(req.body) }); } catch (error) { sendAdminError(req, res, error); } });
  app.patch('/api/admin/payroll/cutoffs/:payrollId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.saveCutoffPayroll(req.body, req.params.payrollId) }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/payroll/cutoffs/:payrollId/finalize', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.finalizeCutoffPayroll(req.params.payrollId) }); } catch (error) { sendAdminError(req, res, error); } });
  app.get('/api/admin/payroll/export', async (req, res) => {
    try {
      requireAdmin(req);
      const rows = await admin.cutoffPayroll();
      const headers = ['Employee #', 'Employee Name', 'Cut Off Rate', 'Daily Rate', 'Standard Working Days', 'Actual Working Days', 'Basic Rate', 'Special Holidays (30%)', 'Regular Holiday (100%)', 'Total Compensation', 'Incentives Allowance', 'Special Allowance', 'Total Allowance', 'Late', 'Halfday', 'Absent', 'Overtime', 'Gross Compensation', 'Signature'];
      const values = rows.map((item) => [item.employeeId, item.employeeName, item.payrollCutoffLabel, item.dailyRate, item.standardWorkingDays, item.actualWorkingDays, item.basicPay, item.specialHolidayPay, item.regularHolidayPay, item.totalCompensation, item.incentivesAllowance, item.specialAllowance, item.totalAllowance, item.lateDeduction, item.halfDayDeduction, item.absenceDeduction, item.overtimePay, item.grossCompensation, item.signaturePlaceholder]);
      const csv = [headers, ...values].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      res.type('text/csv').attachment('payroll-cutoffs.csv').send(csv);
    } catch (error) { sendAdminError(req, res, error); }
  });

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
  app.post('/api/setup/photo', async (req, res) => {
    try {
      const token = setupTokenFromRequest(req.headers as { authorization?: string; 'x-setup-token'?: string });
      setup.authorize(token);
      const userId = String((req.body as { userId?: unknown })?.userId ?? '').trim();
      const dataUrl = String((req.body as { dataUrl?: unknown })?.dataUrl ?? '');
      if (!userId || !dataUrl) throw new SetupError('SETUP_VALIDATION_ERROR', 'userId and dataUrl are required.', 400);
      const photoUrl = await uploadPhotoDataUrl(userId, dataUrl);
      res.status(200).json({ success: true, requestId: req.requestId, photoUrl });
    } catch (error) {
      if (error instanceof Error && error.message === 'Photo storage is not configured') {
        sendSetupError(req, res, new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'Photo storage is not configured. Set BLOB_READ_WRITE_TOKEN before uploading photos.', 503));
        return;
      }
      sendSetupError(req, res, error);
    }
  });

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
    case 'PAYROLL_GENERATION_FAILED': return 503;
    case 'CONFIGURATION_ERROR':
    case 'INTERNAL_SERVER_ERROR': return 500;
    default: return 400;
  }
}

function sendSetupError(req: Request, res: Response, error: unknown): void {
  const setupError = error instanceof SetupError ? error : new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'Setup service is temporarily unavailable.', 503);
  res.status(setupError.status).json(setupError.toResponse(req.requestId));
}

function sendAdminError(req: Request, res: Response, error: unknown): void {
  const adminError = error instanceof AdminError ? error : new AdminError('GOOGLE_SHEETS_UNAVAILABLE', 'Administrator service is temporarily unavailable.', 503);
  res.status(adminError.status).json({ success: false, requestId: req.requestId, error: { code: adminError.code, message: adminError.message } });
}

function cookieValue(req: Request, name: string): string | undefined {
  const value = req.header('cookie')?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return value?.slice(name.length + 1);
}

declare global {
  namespace Express {
    interface Request { requestId: string }
  }
}

export { statusForError };
