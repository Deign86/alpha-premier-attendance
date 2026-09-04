/**
 * Voicebox Name Pronunciation Integration Example (Node.js)
 *
 * Demonstrates fetching phonetic dictionaries and generating SSML phoneme
 * elements for local or remote TTS name synthesis.
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/+$/, '');
const VOICEBOX_KEY = process.env.VOICEBOX_KEY || '';

/**
 * Escapes characters for XML/SSML attribute values and text content.
 * @param {string} str
 * @returns {string}
 */
function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Fetches all pronunciations from the Voicebox API and builds a lookup Map.
 * Keyed by lowercased display name for case-insensitive matching.
 *
 * @param {string} [baseUrl] - Base server URL (default: process.env.BASE_URL || http://localhost:3001)
 * @param {string} [key] - Optional Voicebox API key
 * @returns {Promise<Map<string, { employeeId: string, displayName: string, fullName?: string, phoneticSimple: string | null, phoneticIpa: string | null, languageTag: string | null, notes: string | null }>>}
 */
async function fetchAllPronunciations(baseUrl = BASE_URL, key = VOICEBOX_KEY) {
  const headers = {};
  if (key) {
    headers['x-voicebox-key'] = key;
  }

  const query = key ? `?key=${encodeURIComponent(key)}` : '';
  const url = `${baseUrl}/api/voicebox/pronunciations${query}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Voicebox API error (${response.status}): ${response.statusText}`);
  }

  const data = await response.json();
  const items = Array.isArray(data) ? data : data.pronunciations || [];

  const pronunciationMap = new Map();
  for (const item of items) {
    if (item.displayName) {
      pronunciationMap.set(item.displayName.trim().toLowerCase(), item);
    }
  }

  return pronunciationMap;
}

/**
 * Searches the pronunciation map for a given person's name.
 *
 * @param {string} name - The person's display name or full name
 * @param {Map<string, Object>} pronunciationMap - Map returned by fetchAllPronunciations()
 * @returns {Object|null} Pronunciation object or null if not found
 */
function getPronunciation(name, pronunciationMap) {
  if (!name || !pronunciationMap) return null;
  const lookup = name.trim().toLowerCase();
  return pronunciationMap.get(lookup) || null;
}

/**
 * Builds an SSML string incorporating an IPA phoneme tag if available.
 * If no IPA transcription exists, returns the safely escaped name.
 *
 * @param {string} name - Name to speak
 * @param {Object} [pronunciation] - Pronunciation object from getPronunciation()
 * @returns {string} SSML formatted string or escaped plain name
 */
function buildNameSsml(name, pronunciation) {
  const escapedName = escapeXml(name);
  if (!pronunciation || !pronunciation.phoneticIpa) {
    return escapedName;
  }

  // Clean IPA string: strip surrounding slashes if present
  const cleanIpa = pronunciation.phoneticIpa.replace(/^\/+|\/+$/g, '').trim();
  const escapedIpa = escapeXml(cleanIpa);

  return `<phoneme alphabet="ipa" ph="${escapedIpa}">${escapedName}</phoneme>`;
}

export {
  fetchAllPronunciations,
  getPronunciation,
  buildNameSsml,
  escapeXml,
};

// Standalone CLI runner when executed directly: node client-example.js
if (process.argv[1] && import.meta.url.includes(process.argv[1].replace(/\\/g, '/'))) {
  (async () => {
    try {
      console.log(`[Voicebox Integration] Connecting to: ${BASE_URL}`);
      const map = await fetchAllPronunciations();
      console.log(`[Voicebox Integration] Loaded ${map.size} pronunciation override(s).`);

      const testNames = ['Deign', 'Raineer Rosado', 'Narciso Lontoc', 'Bea', 'Carlos', 'NonExistentName'];
      for (const testName of testNames) {
        const pron = getPronunciation(testName, map);
        const ssml = buildNameSsml(testName, pron);
        console.log(` - Name: "${testName}" -> SSML: ${ssml}`);
      }

    } catch (err) {
      console.error('[Voicebox Integration] Error:', err.message);
    }
  })();
}

