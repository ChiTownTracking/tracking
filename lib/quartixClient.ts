import { parseEnv } from './env';
import { quartixEnvSchema } from './quartixEnv';

export interface QuartixClientConfig {
  baseUrl: string;
  customerId: string;
  username: string;
  password: string;
  application: string;
}

// Quartix doesn't publish the real JWT lifetime; 10 minutes is a conservative
// estimate. An early expiry just costs one refresh round-trip; the 401 retry
// in get() covers the case where even this estimate is too generous.
const TOKEN_LIFETIME_MS = 10 * 60 * 1000;

interface QuartixAuthData {
  AccessToken: string;
  RefreshToken: string;
}

export class QuartixClient {
  private config: QuartixClientConfig;

  // Token cache lives on the instance, not at module level, so independent
  // instances in tests can't leak state into each other.
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;

  constructor(config: QuartixClientConfig) {
    this.config = config;
  }

  private storeTokens(data: QuartixAuthData): string {
    this.accessToken = data.AccessToken;
    this.refreshToken = data.RefreshToken;
    this.expiresAt = Date.now() + TOKEN_LIFETIME_MS;
    return data.AccessToken;
  }

  private async authenticate(): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/auth`, {
      method: 'POST',
      // Quartix rejects multipart/form-data with a 415 — this must stay
      // application/x-www-form-urlencoded.
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        CustomerID: this.config.customerId,
        UserName: this.config.username,
        Password: this.config.password,
        Application: this.config.application,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Quartix authentication failed (${res.status}): ${body}`);
    }
    const { Data } = (await res.json()) as { Data: QuartixAuthData };
    return this.storeTokens(Data);
  }

  private async refresh(): Promise<string> {
    const res = await fetch(`${this.config.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ RefreshToken: this.refreshToken ?? '' }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Quartix token refresh failed (${res.status}): ${body}`);
    }
    const { Data } = (await res.json()) as { Data: QuartixAuthData };
    return this.storeTokens(Data);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    if (this.refreshToken) {
      try {
        return await this.refresh();
      } catch {
        // Refresh token expired or was rejected — fall through to a full
        // re-authentication rather than failing the caller's request.
      }
    }
    return this.authenticate();
  }

  async get(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const url = new URL(this.config.baseUrl + path);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    let res = await fetch(url.toString(), {
      headers: { AccessToken: await this.getAccessToken() },
    });

    if (res.status === 401) {
      // Cached token was rejected despite our lifetime estimate. Drop it and
      // retry exactly once with a freshly obtained token.
      this.accessToken = null;
      this.expiresAt = 0;
      res = await fetch(url.toString(), {
        headers: { AccessToken: await this.getAccessToken() },
      });
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Quartix GET ${path} failed (${res.status}): ${body}`);
    }
    return ((await res.json()) as { Data: unknown }).Data;
  }
}

// Real singleton — the ONLY place real env vars get read. Initialization is
// deferred to first use (rather than module load) so that importing
// QuartixClient in tests, or evaluating this module during `next build`,
// doesn't require QUARTIX_* env vars to exist. Missing vars still fail loudly
// via parseEnv on the first actual call.
let singleton: QuartixClient | null = null;

function resolveSingleton(): QuartixClient {
  if (!singleton) {
    const env = parseEnv(quartixEnvSchema, process.env);
    singleton = new QuartixClient({
      baseUrl: env.QUARTIX_BASE_URL,
      customerId: env.QUARTIX_CUSTOMER_ID,
      username: env.QUARTIX_USERNAME,
      password: env.QUARTIX_PASSWORD,
      application: env.QUARTIX_APPLICATION,
    });
  }
  return singleton;
}

export const quartixClient: QuartixClient = new Proxy({} as QuartixClient, {
  get(_target, prop, _receiver) {
    const client = resolveSingleton();
    const value = Reflect.get(client, prop, client);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
