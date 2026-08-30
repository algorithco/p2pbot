/**
 * Client for the isolated W5 signer microservice (signer:3001).
 * Backend never sees SIGNER_MNEMONIC — all signing is delegated here.
 */
import { config } from '../config';
import logger from '../logger';

const SIGNER_URL = config.signerUrl.replace(/\/+$/, '');
const SIGNER_API_KEY = config.signerApiKey;

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (SIGNER_API_KEY) h['x-api-key'] = SIGNER_API_KEY;
  return h;
}

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const url = `${SIGNER_URL}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers(), ...(opts.headers as Record<string, string> || {}) },
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `signer ${res.status}: ${text.slice(0, 500)}`;
    throw new Error(msg);
  }
  return data as T;
}

export async function getSignerAddress(): Promise<string> {
  const data = await request<{ address: string }>('/address');
  return data.address;
}

export async function getSignerInfo(): Promise<{ address: string | null; deployed: boolean; balance: string; seqno: number | null; configured: boolean }> {
  const data = await request<{ address: string | null; deployed: boolean; balance: string; seqno: number | null; configured: boolean }>('/info');
  // balance may come as bigint string or number; normalize
  return data as never;
}

export async function sendTon(params: { to: string; value: string; comment?: string; bounce?: boolean }): Promise<{ seqno: number }> {
  return request<{ seqno: number }>('/send', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export async function deploySignerWallet(value: string = '0.05'): Promise<{ seqno: number }> {
  return request<{ seqno: number }>('/deploy', {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export async function deployEscrowViaSigner(params: {
  escrowAddress: string;
  escrowStateInit: { codeBoc: string; dataBoc: string };
  value?: string;
  bodyBoc?: string;
}): Promise<{ seqno: number; escrowAddress: string }> {
  return request<{ seqno: number; escrowAddress: string }>('/deploy-escrow', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// Convenience check
export function isSignerConfigured(): boolean {
  return SIGNER_URL.length > 0;
}

export async function checkSignerHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${SIGNER_URL}/health`);
    return res.ok;
  } catch (e) {
    logger.warn('Signer health check failed', e);
    return false;
  }
}
