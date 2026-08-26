import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export type Network = 'mainnet' | 'testnet';

export const MAINNET_ENDPOINT = 'https://toncenter.com/api/v2/jsonRPC';
export const TESTNET_ENDPOINT = 'https://testnet.toncenter.com/api/v2/jsonRPC';

export function getNetwork(): Network {
    const net = (process.env.NETWORK || 'testnet').toLowerCase();
    if (net !== 'mainnet' && net !== 'testnet') {
        throw new Error(`Invalid NETWORK "${net}", expected "mainnet" or "testnet"`);
    }
    return net;
}

export function getEndpoint(): string {
    if (process.env.TONCENTER_ENDPOINT) {
        return process.env.TONCENTER_ENDPOINT;
    }
    return getNetwork() === 'mainnet' ? MAINNET_ENDPOINT : TESTNET_ENDPOINT;
}

export function getApiKey(): string | undefined {
    return process.env.TONCENTER_API_KEY || undefined;
}

/** Directory where generated wallet files are stored */
export function getWalletsDir(): string {
    return process.env.HIGHLOAD_WALLET_DIR || path.resolve(process.cwd(), 'wallets');
}
