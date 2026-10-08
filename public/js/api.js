// Thin fetch wrapper that carries the bearer token and unwraps API errors.

const TOKEN_KEY = 'engineeros.token';

export const token = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (value) => localStorage.setItem(TOKEN_KEY, value),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function request(method, path, body) {
  const headers = {};
  const auth = token.get();
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const base = window.location.pathname.startsWith('/OS') ? '/OS/api' : '/api';
  const cleanPath = path.startsWith('/') ? path : `/${path}`;

  const res = await fetch(`${base}${cleanPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && auth) {
    token.clear();
    location.reload();
    throw new Error('Session expired.');
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text; // SRS routes return HTML/Markdown
  }

  if (typeof data === 'string' && data.trim().startsWith('<') && !cleanPath.includes('/srs')) {
    throw new Error('Server returned an unexpected page instead of API data.');
  }

  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  del: (path) => request('DELETE', path),
};
