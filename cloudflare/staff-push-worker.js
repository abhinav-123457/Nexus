const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}

function base64UrlEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function textToUint8Array(text) {
  return new TextEncoder().encode(text);
}

function pemToArrayBuffer(pem) {
  const normalized = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function normalizeData(data) {
  const output = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null) continue;
    output[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return output;
}

async function importPrivateKey(privateKeyPem) {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign'],
  );
}

async function createAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };
  const claimSet = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const unsignedJwt = `${base64UrlEncode(textToUint8Array(JSON.stringify(header)))}.${base64UrlEncode(textToUint8Array(JSON.stringify(claimSet)))}`;
  const privateKey = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    textToUint8Array(unsignedJwt),
  );
  const jwt = `${unsignedJwt}.${base64UrlEncode(signature)}`;

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`OAuth token exchange failed: ${tokenResponse.status}`);
  }

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    throw new Error('OAuth token exchange returned no access_token');
  }

  return tokenData.access_token;
}

async function sendFcmMessage({ projectId, accessToken, token, notification, data }) {
  const message = {
    token,
    notification,
    data: normalizeData(data),
  };

  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({message}),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`FCM HTTP ${response.status}: ${body}`);
  }

  return response.json();
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: corsHeaders,
      });
    }

    try {
      const serviceAccountRaw = env.FCM_SERVICE_ACCOUNT_JSON;
      const projectId = env.FCM_PROJECT_ID;

      if (!serviceAccountRaw) {
        throw new Error('FCM_SERVICE_ACCOUNT_JSON is not configured');
      }
      if (!projectId) {
        throw new Error('FCM_PROJECT_ID is not configured');
      }

      const serviceAccount = JSON.parse(serviceAccountRaw);
      if (!serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error('FCM_SERVICE_ACCOUNT_JSON is invalid');
      }

      const payload = await request.json();
      const tokens = Array.isArray(payload.tokens) ? payload.tokens.filter(Boolean) : [];
      const notification = payload.notification || {};
      const data = payload.data || {};

      if (tokens.length === 0) {
        return jsonResponse({ ok: true, sent: 0, skipped: true, reason: 'No tokens' });
      }

      const accessToken = await createAccessToken(serviceAccount);
      const results = await Promise.allSettled(
        tokens.map((token) =>
          sendFcmMessage({
            projectId,
            accessToken,
            token,
            notification,
            data,
          }),
        ),
      );

      const success = results.filter((result) => result.status === 'fulfilled').length;
      const failed = results.length - success;

      return jsonResponse({
        ok: failed === 0,
        sent: success,
        failed,
      }, failed === 0 ? 200 : 207);
    } catch (error) {
      return jsonResponse({ ok: false, error: String(error) }, 400);
    }
  },
};
