// Encryption (PBKDF2 + AES-GCM) and storage in this GitHub repo.
// Runs unchanged in the browser and in Node 18+.

export const CONF = {
  owner: 'acse-dc1823',
  repo: 'kks-dinner',
  dataBranch: 'data',
  dataPath: 'data.enc.json',
  configBranch: 'main',
  configPath: 'config.enc.json',
  salt: 'JxvCh8P7gTZkUA5QZE+iRA==',
  iterations: 600000,
  // Encrypted marker, used to check the password before anything else exists.
  check: { v: 1, iv: "Rxn9JEw+qvFrAP0L", ct: "JSqivFxO8hvvVhrcGNbFWIYFWlWI" },
};

const te = new TextEncoder();
const td = new TextDecoder();

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export const fromB64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0));

export async function deriveKey(password, salt = CONF.salt, iterations = CONF.iterations) {
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(salt), iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}
export const exportKey = async (key) => toB64(await crypto.subtle.exportKey('raw', key));
export const importKey = (b64) =>
  crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);

export async function seal(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(value)));
  return { v: 1, iv: toB64(iv), ct: toB64(ct) };
}
export async function unseal(key, box) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(td.decode(pt));
}

// ---- GitHub contents API ----

export class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

const api = (path) => `https://api.github.com/repos/${CONF.owner}/${CONF.repo}/${path}`;

async function gh(token, path, init = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(api(path), { ...init, headers: { ...headers, ...init.headers }, cache: 'no-store' });
  if (!res.ok) throw new HttpError(res.status, `GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const fileB64 = (obj) => btoa(JSON.stringify(obj)); // boxes are pure ASCII

export async function readFile(token, path, branch) {
  const r = await gh(token, `contents/${path}?ref=${branch}`);
  return { box: JSON.parse(atob(r.content.replace(/\s/g, ''))), sha: r.sha };
}

export async function writeFile(token, path, branch, box, sha, message = 'update') {
  const body = { message, content: fileB64(box), branch };
  if (sha) body.sha = sha;
  const r = await gh(token, `contents/${path}`, { method: 'PUT', body: JSON.stringify(body) });
  return r.content.sha;
}

export async function loadData(key, token) {
  const { box, sha } = await readFile(token, CONF.dataPath, CONF.dataBranch);
  return { data: await unseal(key, box), sha };
}

// Re-reads the latest version, applies fn, writes it back. Retries when someone
// else saved in between (409), so concurrent edits from friends never get lost.
export async function mutate(key, token, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { data, sha } = await loadData(key, token);
    fn(data);
    try {
      const newSha = await writeFile(token, CONF.dataPath, CONF.dataBranch, await seal(key, data), sha);
      return { data, sha: newSha };
    } catch (e) {
      if (e.status !== 409) throw e;
      await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
    }
  }
  throw new Error('Could not save after several tries, someone else is editing. Try again.');
}

export const uid = () => toB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, '');
