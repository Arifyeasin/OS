import { Router } from 'express';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { all, get, run } from '../db.js';
import { hashPassword, verifyPassword, issueToken, requireAuth } from '../auth.js';

export const router = Router();

const OAUTH_PROVIDERS = new Set(['google', 'github']);

const appUrl = (req) => {
  if (req && req.headers && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
    return `${proto}://${req.headers.host}`;
  }
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  return 'http://localhost:3000';
};

function createOAuthState(provider, returnTo) {
  const payload = Buffer.from(JSON.stringify({
    provider,
    returnTo: returnTo || 'http://localhost:3000',
    exp: Date.now() + 15 * 60 * 1000,
    nonce: randomBytes(16).toString('hex'),
  })).toString('base64url');
  const signature = createHmac('sha256', process.env.JWT_SECRET || 'secret').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyOAuthState(stateString, expectedProvider) {
  if (!stateString || typeof stateString !== 'string') return null;
  const parts = stateString.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expectedSig = createHmac('sha256', process.env.JWT_SECRET || 'secret').update(payload).digest('base64url');
  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (data.provider !== expectedProvider) return null;
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function providerSettings(provider, req) {
  const settings = provider === 'google'
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        scope: 'openid email profile',
      }
    : {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        authorize: 'https://github.com/login/oauth/authorize',
        token: 'https://github.com/login/oauth/access_token',
        scope: 'read:user user:email',
      };

  const redirectBase = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  return {
    ...settings,
    redirect: `${redirectBase}/api/auth/${provider}/callback`,
  };
}

function configured(provider) {
  const settings = providerSettings(provider);
  return Boolean(settings.clientId && settings.clientSecret);
}

function oauthRedirect(params, origin = 'http://localhost:3000') {
  const url = new URL((origin || 'http://localhost:3000').replace(/\/$/, ''));
  url.hash = new URLSearchParams(params).toString();
  return url.toString();
}

function socialUser(provider, profile, accessToken = '') {
  const providerId = String(profile.id || profile.sub || '').trim();
  let email = String(profile.email || '').trim().toLowerCase();
  if (!email && profile.login) email = `${profile.login}@users.noreply.github.com`;
  if (!providerId || !email) throw new Error('The provider did not return a verified email address.');

  const avatarUrl = String(profile.picture || profile.avatar_url || '').trim();
  const githubUsername = provider === 'github' ? String(profile.login || '').trim() : '';
  const linked = get('SELECT id, user_id FROM oauth_accounts WHERE provider = ? AND provider_user_id = ?', provider, providerId);

  let user = linked
    ? get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE id = ?', linked.user_id)
    : get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE email = ?', email);

  if (!user) {
    const name = String(profile.name || profile.login || email.split('@')[0]).trim().slice(0, 120) || 'EngineerOS user';
    const created = run(
      'INSERT INTO users (name, email, password, role, avatar_url, github_username, github_token) VALUES (?, ?, ?, ?, ?, ?, ?)',
      name,
      email,
      hashPassword('demo1234'),
      'DEVELOPER',
      avatarUrl,
      githubUsername,
      provider === 'github' ? accessToken : ''
    );
    user = get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE id = ?', created.lastInsertRowid);
  } else {
    run(
      "UPDATE users SET avatar_url = CASE WHEN COALESCE(avatar_url, '') = '' THEN ? ELSE avatar_url END, github_username = CASE WHEN ? != '' AND COALESCE(github_username, '') = '' THEN ? ELSE github_username END, github_token = CASE WHEN ? != '' THEN ? ELSE github_token END WHERE id = ?",
      avatarUrl,
      githubUsername,
      githubUsername,
      accessToken,
      accessToken,
      user.id
    );
    user = get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE id = ?', user.id);
  }

  if (!linked) {
    run(
      'INSERT INTO oauth_accounts (user_id, provider, provider_user_id, username, access_token) VALUES (?, ?, ?, ?, ?)',
      user.id,
      provider,
      providerId,
      githubUsername,
      accessToken
    );
  } else if (provider === 'github' && accessToken) {
    run('UPDATE oauth_accounts SET username = ?, access_token = ? WHERE id = ?', githubUsername, accessToken, linked.id);
  }

  return user;
}

router.get('/providers', (_req, res) => {
  res.json({ google: configured('google'), github: configured('github') });
});

router.post('/register', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = String(req.body.role || 'DEVELOPER').toUpperCase();

  if (!name || name.length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (get('SELECT id FROM users WHERE email = ?', email)) return res.status(409).json({ error: 'An account with this email already exists.' });

  const created = run(
    'INSERT INTO users (name, email, password, role, avatar_url) VALUES (?, ?, ?, ?, ?)',
    name,
    email,
    hashPassword(password),
    role,
    ''
  );

  const user = get('SELECT id, name, email, role, avatar_url FROM users WHERE id = ?', created.lastInsertRowid);
  const organization = run('INSERT INTO organizations (name, owner_id) VALUES (?, ?)', `${name}'s Organization`, user.id);
  run('INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, ?)', organization.lastInsertRowid, user.id, 'OWNER');

  const payload = { id: user.id, name: user.name, email: user.email, role: user.role, avatar_url: user.avatar_url || '' };
  res.status(201).json({ token: issueToken(payload), user: payload });
});

router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const row = get('SELECT * FROM users WHERE email = ?', email);

  if (!row) {
    return res.status(401).json({ error: 'No account found with this email. Please check your spelling or create an account.' });
  }

  if (!verifyPassword(password, row.password)) {
    const oauth = get('SELECT provider FROM oauth_accounts WHERE user_id = ?', row.id);
    if (oauth) {
      const providerLabel = oauth.provider === 'google' ? 'Google' : (oauth.provider === 'github' ? 'GitHub' : oauth.provider);
      return res.status(401).json({
        error: `Incorrect password. This account was registered with ${providerLabel}. You can sign in using "Continue with ${providerLabel}", or use "Forgot / Set password" below.`,
        isOAuth: true,
        provider: oauth.provider,
      });
    }
    return res.status(401).json({ error: 'Incorrect email or password. Use "Forgot / Set password" below if you need to reset it.' });
  }

  const user = {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    avatar_url: row.avatar_url || '',
    github_username: row.github_username || '',
    has_github_token: Boolean(row.github_token),
  };

  res.json({ token: issueToken(user), user });
});

router.post('/reset-password', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const newPassword = String(req.body.password || req.body.newPassword || '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  const user = get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE email = ?', email);
  if (!user) {
    return res.status(404).json({ error: 'No account found with this email address.' });
  }

  run('UPDATE users SET password = ? WHERE id = ?', hashPassword(newPassword), user.id);

  const payload = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    avatar_url: user.avatar_url || '',
    github_username: user.github_username || '',
    has_github_token: Boolean(user.github_token),
  };

  res.json({
    message: 'Password updated successfully! You are now logged in.',
    token: issueToken(payload),
    user: payload,
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
      avatar_url: req.user.avatar_url || '',
      github_username: req.user.github_username || '',
      has_github_token: Boolean(req.user.github_token),
    },
  });
});

router.patch('/profile', requireAuth, (req, res) => {
  const name = req.body.name !== undefined ? String(req.body.name).trim() : req.user.name;
  const avatarUrl = req.body.avatar_url !== undefined ? String(req.body.avatar_url).trim() : (req.user.avatar_url || '');
  const githubUsername = req.body.github_username !== undefined ? String(req.body.github_username).trim().replace(/^@/, '') : (req.user.github_username || '');
  const githubToken = req.body.github_token !== undefined ? String(req.body.github_token).trim() : (req.user.github_token || '');

  if (name && name.length < 2) {
    return res.status(400).json({ error: 'Name must be at least 2 characters.' });
  }

  run('UPDATE users SET name = ?, avatar_url = ?, github_username = ?, github_token = ? WHERE id = ?',
    name || req.user.name, avatarUrl, githubUsername, githubToken, req.user.id);

  const updated = get('SELECT id, name, email, role, avatar_url, github_username, github_token FROM users WHERE id = ?', req.user.id);
  res.json({
    user: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      role: updated.role,
      avatar_url: updated.avatar_url || '',
      github_username: updated.github_username || '',
      has_github_token: Boolean(updated.github_token),
    },
  });
});

router.get('/users', requireAuth, (_req, res) => {
  res.json(all('SELECT id, name, email, role, avatar_url, github_username FROM users ORDER BY name'));
});

router.get('/:provider', (req, res) => {
  const provider = req.params.provider;
  if (!OAUTH_PROVIDERS.has(provider)) return res.status(404).json({ error: 'Unknown authentication provider.' });
  if (!configured(provider)) {
    const origin = (req && req.headers && req.headers.host)
      ? `${req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')}://${req.headers.host}`
      : 'http://localhost:3000';
    return res.redirect(oauthRedirect({ oauth_error: `${provider === 'google' ? 'Google' : 'GitHub'} login is not configured on this server.` }, origin));
  }

  const origin = (req && req.headers && req.headers.host)
    ? `${req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')}://${req.headers.host}`
    : (process.env.APP_URL || 'http://localhost:3000');
  const state = createOAuthState(provider, origin);

  const settings = providerSettings(provider, req);
  const params = {
    client_id: settings.clientId,
    redirect_uri: settings.redirect,
    response_type: 'code',
    scope: settings.scope,
    state,
  };

  const query = new URLSearchParams(params);
  if (provider === 'google') query.set('access_type', 'online');
  res.redirect(`${settings.authorize}?${query}`);
});

router.get('/:provider/callback', async (req, res) => {
  const provider = req.params.provider;
  const state = String(req.query.state || '');
  const stateData = verifyOAuthState(state, provider);
  const returnOrigin = stateData?.returnTo || ((req && req.headers && req.headers.host)
    ? `${req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')}://${req.headers.host}`
    : (process.env.APP_URL || 'http://localhost:3000'));

  if (!OAUTH_PROVIDERS.has(provider) || !stateData) {
    return res.redirect(oauthRedirect({ oauth_error: 'Invalid or expired social login session. Please try again.' }, returnOrigin));
  }

  if (req.query.error) {
    const description = req.query.error_description || req.query.error;
    return res.redirect(oauthRedirect({ oauth_error: `Social login was cancelled: ${description}` }, returnOrigin));
  }

  try {
    const settings = providerSettings(provider, req);
    const tokenBody = {
      grant_type: 'authorization_code',
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      code: req.query.code,
      redirect_uri: settings.redirect,
    };

    const tokenResponse = await fetch(settings.token, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenBody).toString(),
      signal: AbortSignal.timeout(15000),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(tokenData.error_description || tokenData.error || 'The provider did not issue an access token.');
    }

    const headers = {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/json',
      'User-Agent': 'EngineerOS',
    };

    let profile;
    if (provider === 'google') {
      const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      profile = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profile.message || 'Could not read the Google profile.');
      if (profile.email_verified !== true && profile.email_verified !== 'true') {
        throw new Error('Google did not verify this email address.');
      }
    } else {
      const profileResponse = await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(15000) });
      profile = await profileResponse.json();
      if (!profileResponse.ok) throw new Error(profile.message || 'Could not read the GitHub profile.');

      const emailsResponse = await fetch('https://api.github.com/user/emails', { headers, signal: AbortSignal.timeout(15000) });
      if (emailsResponse.ok) {
        const emails = await emailsResponse.json();
        if (Array.isArray(emails)) {
          profile.email = emails.find((email) => email.primary && email.verified)?.email
            || emails.find((email) => email.verified)?.email
            || emails[0]?.email;
        }
      }
      if (!profile.email && profile.login) {
        profile.email = `${profile.login}@users.noreply.github.com`;
      }
    }

    const user = socialUser(provider, profile, tokenData.access_token);
    return res.redirect(oauthRedirect({ oauth_token: issueToken(user) }, returnOrigin));
  } catch (error) {
    return res.redirect(oauthRedirect({ oauth_error: error.message || 'Social login failed.' }, returnOrigin));
  }
});
