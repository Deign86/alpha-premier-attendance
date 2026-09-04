import { Router, type Request, type Response } from 'express';
import type { UpsertPronunciationRequest } from '@rfid-attendance/shared';
import {
  findPronunciationsByName,
  getAllVoiceboxPronunciations,
  listVoiceboxNames,
  upsertPronunciation,
} from './voicebox-db.js';

export interface VoiceboxRouterOptions {
  dbPath?: string;
}

interface PronunciationBodyInput {
  displayName?: string;
  phoneticSimple?: string;
  phoneticIpa?: string;
  languageTag?: string;
  notes?: string;
}

export function extractStringProp<T>(value: T): string | undefined {
  if (value !== undefined && value !== null && Object.prototype.toString.call(value) === '[object String]') {
    // SAFETY: Verified that value is a string via Object.prototype.toString
    return (value as string).trim();
  }
  return undefined;
}

export function cleanIpaString(rawIpa: string): string {
  return rawIpa.trim().replace(/^\/+|\/+$/g, '').trim();
}

export function createVoiceboxRouter(options?: VoiceboxRouterOptions): Router {
  const router = Router();

  // GET /api/voicebox-names: returns listVoiceboxNames()
  router.get('/api/voicebox-names', (_req: Request, res: Response) => {
    try {
      const names = listVoiceboxNames(options?.dbPath);
      res.status(200).json(names);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  // GET /api/voicebox-names/:employeeId: returns detailed single employee info with pronunciation
  router.get('/api/voicebox-names/:employeeId', (req: Request, res: Response) => {
    try {
      const employeeId = extractStringProp(req.params.employeeId);
      if (!employeeId) {
        res.status(400).json({ error: 'Employee ID is required.' });
        return;
      }
      const all = listVoiceboxNames(options?.dbPath);
      const found = all.find((item) => item.employeeId === employeeId);
      if (!found) {
        res.status(404).json({ error: `Employee not found with ID: ${employeeId}` });
        return;
      }
      res.status(200).json(found);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  // POST /api/voicebox-names/:employeeId/pronunciation: validates body, calls upsertPronunciation, returns updated record
  router.post('/api/voicebox-names/:employeeId/pronunciation', (req: Request, res: Response) => {
    try {
      const employeeId = extractStringProp(req.params.employeeId);
      if (!employeeId) {
        res.status(400).json({ error: 'Employee ID is required.' });
        return;
      }

      const rawBody: unknown = req.body;
      if (!rawBody || Object.prototype.toString.call(rawBody) !== '[object Object]' || Array.isArray(rawBody)) {
        res.status(400).json({ error: 'Request body must be a valid JSON object.' });
        return;
      }

      // SAFETY: Checked that rawBody is a non-null object and not an array
      const bodyObj = rawBody as PronunciationBodyInput;
      const requestData: UpsertPronunciationRequest = {};
      if (bodyObj.displayName !== undefined) {
        requestData.displayName = extractStringProp(bodyObj.displayName) ?? '';
      }
      if (bodyObj.phoneticSimple !== undefined) {
        requestData.phoneticSimple = extractStringProp(bodyObj.phoneticSimple) ?? '';
      }
      if (bodyObj.phoneticIpa !== undefined) {
        requestData.phoneticIpa = extractStringProp(bodyObj.phoneticIpa) ?? '';
      }
      if (bodyObj.languageTag !== undefined) {
        requestData.languageTag = extractStringProp(bodyObj.languageTag) ?? '';
      }
      if (bodyObj.notes !== undefined) {
        requestData.notes = extractStringProp(bodyObj.notes) ?? '';
      }

      const updated = upsertPronunciation(employeeId, requestData, options?.dbPath);
      res.status(200).json({
        success: true,
        pronunciation: updated,
        record: updated,
        ...updated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update pronunciation';
      res.status(500).json({ success: false, error: { message } });
    }


  });

  // GET /api/voicebox/pronunciations: returns getAllVoiceboxPronunciations() with optional API key check
  router.get('/api/voicebox/pronunciations', (req: Request, res: Response) => {
    try {
      const configuredKey = process.env.VOICEBOX_KEY?.trim();
      if (configuredKey) {
        const headerKey = extractStringProp(req.headers['x-voicebox-key']);
        const queryKey = extractStringProp(req.query.voiceboxKey);
        const providedKey = headerKey || queryKey;
        if (providedKey !== configuredKey) {
          res.status(401).json({ error: 'Unauthorized: invalid or missing Voicebox API key.' });
          return;
        }
      }

      const pronunciations = getAllVoiceboxPronunciations(options?.dbPath);
      res.status(200).json(pronunciations);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  // GET /api/voicebox/pronunciation: query parameter ?name=... case-insensitive match on displayName and fullName
  router.get('/api/voicebox/pronunciation', (req: Request, res: Response) => {
    try {
      const name = extractStringProp(req.query.name);
      if (!name) {
        res.status(400).json({ error: 'Query parameter "name" is required.' });
        return;
      }
      const matches = findPronunciationsByName(name, options?.dbPath);
      res.status(200).json(matches);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  // GET /api/voicebox/ssml: query parameter ?name=... SSML generation
  router.get('/api/voicebox/ssml', (req: Request, res: Response) => {
    try {
      const name = extractStringProp(req.query.name);
      if (!name) {
        res.status(400).type('application/xml').send('<speak></speak>');
        return;
      }

      const matches = findPronunciationsByName(name, options?.dbPath);
      const matchWithIpa = matches.find((m) => m.phoneticIpa && m.phoneticIpa.trim().length > 0);
      if (matchWithIpa && matchWithIpa.phoneticIpa) {
        const cleanIpa = cleanIpaString(matchWithIpa.phoneticIpa);
        if (cleanIpa) {
          const displayName = matchWithIpa.displayName || name;
          res.type('application/xml').send(`<speak><phoneme alphabet="ipa" ph="${cleanIpa}">${displayName}</phoneme></speak>`);
          return;
        }
      }

      res.type('application/xml').send(`<speak>${name}</speak>`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
