const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_OAUTH_ENV = 'GOOGLE_DRIVE_OAUTH_CREDENTIALS';

let cachedOAuthToken = { token: '', expiresAt: 0 };
let cachedRuntimeToken = { token: '', expiresAt: 0 };

const readOAuthCredentials = () => {
  const raw = String(process.env[DRIVE_OAUTH_ENV] ?? '').trim();
  if (!raw) return null;

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error(`${DRIVE_OAUTH_ENV} must contain JSON with client_id, client_secret, and refresh_token.`);
  }

  const clientConfiguration = credentials.installed ?? credentials.web ?? credentials;
  const clientId = String(clientConfiguration.client_id ?? clientConfiguration.clientId ?? credentials.client_id ?? credentials.clientId ?? '').trim();
  const clientSecret = String(clientConfiguration.client_secret ?? clientConfiguration.clientSecret ?? credentials.client_secret ?? credentials.clientSecret ?? '').trim();
  const refreshToken = String(credentials.refresh_token ?? credentials.refreshToken ?? credentials.tokens?.refresh_token ?? '').trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(`${DRIVE_OAUTH_ENV} must contain client_id, client_secret, and refresh_token.`);
  }
  return { clientId, clientSecret, refreshToken };
};

const getOAuthAccessToken = async (credentials) => {
  if (cachedOAuthToken.token && cachedOAuthToken.expiresAt > Date.now() + 60_000) return cachedOAuthToken.token;

  const response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: credentials.refreshToken,
    }),
  });

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Keep token endpoint response bodies out of logs and errors.
  }
  if (!response.ok || !payload.access_token) {
    const reason = String(payload.error ?? 'token_refresh_failed').replace(/[^a-z0-9_]/gi, '').slice(0, 60);
    throw new Error(`Google Drive OAuth refresh failed (${reason}). Check the OAuth refresh token, consent, and Drive scope.`);
  }

  const grantedScopes = String(payload.scope ?? '').split(/\s+/).filter(Boolean);
  if (grantedScopes.length && !grantedScopes.includes(DRIVE_SCOPE)) {
    throw new Error(`The OAuth token must be authorized with the ${DRIVE_SCOPE} scope to read and write the configured Drive folder.`);
  }

  cachedOAuthToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
  };
  return cachedOAuthToken.token;
};

const getRuntimeServiceAccountToken = async () => {
  if (cachedRuntimeToken.token && cachedRuntimeToken.expiresAt > Date.now() + 60_000) return cachedRuntimeToken.token;
  const metadataUrl = new URL('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token');
  metadataUrl.searchParams.set('scopes', DRIVE_SCOPE);
  const response = await fetch(metadataUrl, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!response.ok) {
    throw new Error('Could not obtain a Google Drive token. Configure the OAuth secret or confirm the function has a runtime service account.');
  }
  const payload = await response.json();
  if (!payload.access_token) throw new Error('The Google identity returned no Drive access token.');
  cachedRuntimeToken = {
    token: payload.access_token,
    expiresAt: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
  };
  return cachedRuntimeToken.token;
};

/** Uses user OAuth from functions/.env; keeps the runtime identity as a fallback until OAuth is configured. */
export const getGoogleDriveAccessToken = async () => {
  const credentials = readOAuthCredentials();
  if (credentials) return getOAuthAccessToken(credentials);
  return getRuntimeServiceAccountToken();
};
