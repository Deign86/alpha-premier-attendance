import crypto from 'node:crypto';
import path from 'node:path';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import morgan from 'morgan';
import type { ScanRequest } from '@rfid-attendance/shared';
import { DEFAULT_OFFICE_IDENTITY, resolveOfficeDisplay } from '@rfid-attendance/shared';
import { AttendanceService } from './attendance.js';
import { asScanError, ScanError } from './errors.js';
import { safeConfig, type AppConfig } from './config.js';
import type { GoogleSheetsService } from './sheets.js';
import { manilaTimestamp } from './time.js';
import { SetupError, SetupService, setupTokenFromRequest } from './setup.js';
import { AdminError, AdminService } from './admin.js';
import { uploadPhotoDataUrl } from './photo-storage.js';
import { createVoiceboxRouter } from './voicebox-routes.js';

export type CreateAppOptions = { sheets: GoogleSheetsService; config: AppConfig; logger?: boolean; staticDir?: string; voiceboxDbPath?: string };

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
  const trustedOrigins = options.config.corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || trustedOrigins.includes('*') || trustedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('Origin is not trusted by the attendance API.'));
    },
  }));
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
    const rawBody: unknown = req.body;
    let rfidUid = '';
    let source: ScanRequest['source'] = 'RFID';
    if (rawBody && Object.prototype.toString.call(rawBody) === '[object Object]' && !Array.isArray(rawBody)) {
      // SAFETY: Checked that rawBody is a non-null object
      const bodyObj = rawBody as { rfidUid?: unknown; source?: unknown };
      if (Object.prototype.toString.call(bodyObj.rfidUid) === '[object String]') {
        // SAFETY: Checked that rfidUid is a string
        rfidUid = bodyObj.rfidUid as string;
      }
      if (bodyObj.source === 'RFID' || bodyObj.source === 'MANUAL_TEST') {
        source = bodyObj.source;
      }
    }
    const result = await attendance.scan({ rfidUid, source }, req.requestId);
    if ('error' in result) res.status(statusForError(result.error.code)).json(result);
    else res.status(200).json(result);
  };
  app.post('/api/attendance/scan', scanHandler);
  app.post('/api/scan', scanHandler);

  app.get('/api/attendance', async (req, res) => {
    try {
      const queryDate = asString(req.query.date);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(queryDate) ? queryDate : new Intl.DateTimeFormat('en-CA', { timeZone: options.config.timezone }).format(new Date());
      res.json({ success: true, date, attendance: await admin.attendance(date), fetchedAt: manilaTimestamp(new Date(), options.config.timezone) });
    } catch { res.status(503).json({ success: false, requestId: req.requestId, error: { code: 'GOOGLE_SHEETS_UNAVAILABLE', message: 'Attendance data is temporarily unavailable.' } }); }
  });

  app.post('/api/admin/unlock', async (req, res) => {
    try {
      // SAFETY: Extracting pin or rfidUid property from request body
      const pin = req.body && Object.prototype.toString.call(req.body) === '[object Object]' ? (req.body as { pin?: unknown; rfidUid?: unknown }).pin ?? (req.body as { pin?: unknown; rfidUid?: unknown }).rfidUid : undefined;
      const result = await admin.unlock(pin);
      res.setHeader('Set-Cookie', `rfid_admin=${result.token}; Max-Age=${(options.config.adminSessionMinutes ?? 15) * 60}; Path=/; HttpOnly; SameSite=Strict${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
      res.json({ success: true, requestId: req.requestId, expiresAt: result.expiresAt });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.get('/api/admin/session', (req, res) => { try { const token = cookieValue(req, 'rfid_admin'); requireAdmin(req); res.json({ success: true, requestId: req.requestId, expiresAt: new Date(Number(token!.split('.')[0])).toISOString() }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/lock', (req, res) => { res.setHeader('Set-Cookie', 'rfid_admin=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict'); res.json({ success: true, requestId: req.requestId }); });
  const requireAdmin = (req: Request) => admin.verify(cookieValue(req, 'rfid_admin'));
  app.get('/api/admin/users', async (req, res) => { try { requireAdmin(req); res.json({ success: true, users: await admin.users() }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/users', async (req, res) => { try { requireAdmin(req); res.json({ success: true, ...(await admin.saveUser(req.body)) }); } catch (error) { sendAdminError(req, res, error); } });
  app.patch('/api/admin/users/:userId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, ...(await admin.saveUser(req.body, req.params.userId)) }); } catch (error) { sendAdminError(req, res, error); } });
  app.delete('/api/admin/users/:userId', async (req, res) => { try { requireAdmin(req); await admin.deleteUser(req.params.userId); res.json({ success: true, requestId: req.requestId }); } catch (error) { sendAdminError(req, res, error); } });
  app.get('/api/admin/attendance', async (req, res) => {
    try {
      requireAdmin(req);
      const queryDate = asString(req.query.date);
      const date = queryDate || new Intl.DateTimeFormat('en-CA', { timeZone: options.config.timezone }).format(new Date());
      res.json({ success: true, date, attendance: await admin.attendance(date, true), fetchedAt: manilaTimestamp(new Date(), options.config.timezone) });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.post('/api/admin/attendance/backdate', async (req, res) => {
    try {
      requireAdmin(req);
      res.json({ success: true, attendance: await admin.createBackdatedAttendance(req.body) });
    } catch (error) {
      sendAdminError(req, res, error);
    }
  });
  app.patch('/api/admin/attendance/:attendanceId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, attendance: await admin.updateAttendance(req.params.attendanceId, req.body) }); } catch (error) { sendAdminError(req, res, error); } });
  app.delete('/api/admin/attendance/:attendanceId', async (req, res) => {
    try {
      requireAdmin(req);
      const date = asString(req.query.date);
      await admin.deleteAttendance(req.params.attendanceId, date);
      res.json({ success: true, requestId: req.requestId });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.get('/api/bathroom/status', async (req, res) => {
    try {
      const date = asString(req.query.date);
      res.json(await admin.bathroomStatus(date || undefined));
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.post('/api/bathroom/scan', async (req, res) => {
    try {
      // SAFETY: Extracting rfidUid property from request body
      const rfidUid = req.body && Object.prototype.toString.call(req.body) === '[object Object]' ? asString((req.body as { rfidUid?: unknown }).rfidUid) : '';
      const result = await admin.bathroomScanRfid(rfidUid);
      res.json(result);
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.get('/api/admin/bathroom/status', async (req, res) => {
    try {
      requireAdmin(req);
      const date = asString(req.query.date);
      res.json(await admin.bathroomStatus(date || undefined));
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.post('/api/admin/bathroom/time-out', async (req, res) => {
    try {
      requireAdmin(req);
      res.json({ success: true, entry: await admin.bathroomTimeOut(req.body) });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.post('/api/admin/bathroom/time-in', async (req, res) => {
    try {
      requireAdmin(req);
      res.json({ success: true, entry: await admin.bathroomTimeIn(req.body) });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.patch('/api/admin/bathroom/:logId', async (req, res) => {
    try {
      requireAdmin(req);
      const logId = asString(req.params.logId);
      res.json({ success: true, entry: await admin.updateBathroomLog(logId, req.body) });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.patch('/api/bathroom-key-logs/:logId', async (req, res) => {
    try {
      requireAdmin(req);
      const logId = asString(req.params.logId);
      res.json({ success: true, entry: await admin.updateBathroomLog(logId, req.body) });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.get('/api/admin/payroll/profiles', async (req, res) => { try { requireAdmin(req); res.json({ success: true, profiles: await admin.payrollProfiles() }); } catch (error) { sendAdminError(req, res, error); } });
  app.put('/api/admin/payroll/profiles/:profileId', async (req, res) => {
    try {
      requireAdmin(req);
      // SAFETY: Merging params profileId with request body object
      const profileBody = req.body && Object.prototype.toString.call(req.body) === '[object Object]' ? (req.body as object) : {};
      res.json({ success: true, profile: await admin.savePayrollProfile({ ...profileBody, profileId: req.params.profileId }) });
    } catch (error) { sendAdminError(req, res, error); }
  });
  app.get('/api/admin/payroll/cutoffs', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.cutoffPayroll() }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/payroll/cutoffs', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.saveCutoffPayroll(req.body) }); } catch (error) { sendAdminError(req, res, error); } });
  app.patch('/api/admin/payroll/cutoffs/:payrollId', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.saveCutoffPayroll(req.body, req.params.payrollId) }); } catch (error) { sendAdminError(req, res, error); } });
  app.post('/api/admin/payroll/cutoffs/:payrollId/finalize', async (req, res) => { try { requireAdmin(req); res.json({ success: true, payroll: await admin.finalizeCutoffPayroll(req.params.payrollId) }); } catch (error) { sendAdminError(req, res, error); } });
  app.delete('/api/admin/payroll/cutoffs/:payrollId', async (req, res) => { try { requireAdmin(req); await admin.deleteCutoffPayroll(req.params.payrollId); res.json({ success: true }); } catch (error) { sendAdminError(req, res, error); } });
  app.get('/api/admin/payroll/export', async (req, res) => {
    try {
      requireAdmin(req);
      const office = options.config.office ?? DEFAULT_OFFICE_IDENTITY;
      const rows = await admin.cutoffPayroll();
      const headers = ['Employee #', 'Employee Name', 'Cut Off Rate', 'Daily Rate', 'Standard Working Days', 'Actual Working Days', 'Basic Rate', 'Special Holidays (30%)', 'Regular Holiday (100%)', 'Total Compensation', 'Incentives Allowance', 'Special Allowance', 'Total Allowance', 'Late', 'Halfday', 'Absent', 'Overtime', 'Gross Compensation'];
      const values = rows.map((item) => [item.employeeId, item.employeeName, item.payrollCutoffLabel, item.dailyRate, item.standardWorkingDays, item.actualWorkingDays, item.basicPay, item.specialHolidayPay, item.regularHolidayPay, item.totalCompensation, item.incentivesAllowance, item.specialAllowance, item.totalAllowance, item.lateDeduction, item.halfDayDeduction, item.absenceDeduction, item.overtimePay, item.grossCompensation]);
      const csv = [
        ['Company', office.companyName],
        ['Office', resolveOfficeDisplay(office, 'full')],
        headers,
        ...values,
      ].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      res.type('text/csv').attachment('payroll-cutoffs.csv').send(csv);
    } catch (error) { sendAdminError(req, res, error); }
  });

  app.post('/api/setup/unlock', async (req, res) => {
    try {
      // SAFETY: Extracting pin or rfidUid property from request body
      const pin = req.body && Object.prototype.toString.call(req.body) === '[object Object]' ? (req.body as { pin?: unknown; rfidUid?: unknown }).pin ?? (req.body as { pin?: unknown; rfidUid?: unknown }).rfidUid : undefined;
      const result = await setup.unlock(pin);
      res.status(200).json({ success: true, requestId: req.requestId, ...result });
    } catch (error) { sendSetupError(req, res, error); }
  });

  const lockHandler = (req: Request, res: Response) => {
    try {
      setup.lock(getSetupToken(req));
      res.status(200).json({ success: true, requestId: req.requestId });
    } catch (error) { sendSetupError(req, res, error); }
  };
  app.post('/api/setup/lock', lockHandler);

  const cardLookupHandler = async (req: Request, res: Response) => {
    try {
      const paramUid = asString(req.params.rfidUid);
      const queryUid = asString(req.query.rfidUid);
      const rawUid = paramUid || queryUid || '';
      const result = await setup.lookupCard(getSetupToken(req), rawUid);
      res.status(200).json({ success: true, requestId: req.requestId, ...result });
    } catch (error) { sendSetupError(req, res, error); }
  };
  app.get('/api/setup/card', cardLookupHandler);
  app.get('/api/setup/card/:rfidUid', cardLookupHandler);
  app.get('/api/setup/cards/:rfidUid', cardLookupHandler);

  const upsertUserHandler = async (req: Request, res: Response) => {
    try {
      const result = await setup.upsertUser(getSetupToken(req), req.body);
      res.status(200).json({ success: true, requestId: req.requestId, ...result });
    } catch (error) { sendSetupError(req, res, error); }
  };
  app.post('/api/setup/user', upsertUserHandler);
  app.post('/api/setup/users', upsertUserHandler);
  app.post('/api/setup/photo', async (req, res) => {
    try {
      const token = getSetupToken(req);
      setup.authorize(token);
      // SAFETY: Checking that req.body is an object before reading userId
      const userId = req.body && Object.prototype.toString.call(req.body) === '[object Object]' && Object.prototype.toString.call((req.body as { userId?: unknown }).userId) === '[object String]' ? String((req.body as { userId?: unknown }).userId).trim() : '';
      // SAFETY: Checking that req.body is an object before reading dataUrl
      const dataUrl = req.body && Object.prototype.toString.call(req.body) === '[object Object]' && Object.prototype.toString.call((req.body as { dataUrl?: unknown }).dataUrl) === '[object String]' ? String((req.body as { dataUrl?: unknown }).dataUrl) : '';
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

  app.use(createVoiceboxRouter({ dbPath: options.voiceboxDbPath }));

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

function asString<T>(value: T): string {
  if (value && Object.prototype.toString.call(value) === '[object String]') {
    // SAFETY: Verified that value is a string
    return value as string;
  }
  return '';
}

function getSetupToken(req: Request): string | undefined {
  const authHeader = req.header('authorization');
  const setupHeader = req.header('x-setup-token');
  return setupTokenFromRequest({ authorization: authHeader, 'x-setup-token': setupHeader });
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

function sendSetupError<T>(req: Request, res: Response, error: T): void {
  const setupError = error instanceof SetupError ? error : new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'Setup service is temporarily unavailable.', 503);
  res.status(setupError.status).json(setupError.toResponse(req.requestId));
}

function sendAdminError<T>(req: Request, res: Response, error: T): void {
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
