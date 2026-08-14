// ============================================================
// SlipDAW — persistence
//
// The project document is small JSON and lives in localStorage for autosave.
// Audio assets do NOT: a single imported WAV is megabytes and localStorage
// caps out around 5MB, so samples go to IndexedDB as raw Float32 channel
// data. Keeping the two apart means a project with samples still autosaves
// instantly instead of throwing a quota error halfway through.
// ============================================================

const PROJECT_KEY = 'slipdaw.project.v1';
const DB_NAME = 'slipdaw';
const STORE = 'assets';

export function saveProjectLocal(project) {
  try {
    localStorage.setItem(PROJECT_KEY, JSON.stringify(project));
    return true;
  } catch (err) {
    // Quota, private-browsing, or a disabled storage partition. Autosave is
    // a convenience, never a correctness requirement — the user's work is
    // still in memory and still exportable.
    console.warn('SlipDAW: autosave failed', err);
    return false;
  }
}

export function loadProjectLocal() {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearProjectLocal() {
  try { localStorage.removeItem(PROJECT_KEY); } catch {}
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Store an AudioBuffer's raw samples. Buffers are bound to the context that
 *  created them and cannot be serialised directly, so this keeps plain
 *  Float32Arrays plus the metadata needed to rebuild one. */
export async function putAsset(id, audioBuffer) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c).slice());
  }
  const record = { channels, sampleRate: audioBuffer.sampleRate, length: audioBuffer.length };
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(record, id);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return true;
  } catch (err) {
    console.warn('SlipDAW: could not persist audio asset', err);
    return false;
  }
}

export async function getAsset(id, ctx) {
  try {
    const db = await openDb();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!record) return null;
    const buf = ctx.createBuffer(record.channels.length, record.length, record.sampleRate);
    record.channels.forEach((data, i) => buf.copyToChannel(data, i));
    return buf;
  } catch {
    return null;
  }
}

export async function deleteAsset(id) {
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = resolve;
      tx.onerror = resolve;
    });
    db.close();
  } catch {}
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers; a short
  // delay is the usual workaround.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
