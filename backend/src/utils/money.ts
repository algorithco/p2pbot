export const ASSET_DECIMALS: Record<string, number> = {
  TON: 9,
  USDT: 6,
};

/** Expand a JS number into a plain decimal string without exponent notation. */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value: ${n}`);
  let s = String(n);
  if (s.includes('e') || s.includes('E')) {
    const [mantissa, expStr] = s.split(/[eE]/);
    const exp = parseInt(expStr, 10);
    const [intPart, fracPart = ''] = mantissa.split('.');
    let digits = intPart + fracPart;
    let point = intPart.length + exp;
    if (point <= 0) {
      digits = '0'.repeat(1 - point) + digits;
      point = 1;
    }
    while (digits.length < point) digits += '0';
    s = digits.slice(0, point) + '.' + digits.slice(point);
  }
  return s;
}

function parseToScaled(input: string | number, decimals: number): bigint {
  const raw = typeof input === 'number' ? numberToPlainString(input) : String(input).trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) {
    throw new Error(`Invalid decimal value: ${raw}`);
  }
  const [mantissa, expStr] = raw.split(/[eE]/);
  const exp = expStr ? parseInt(expStr, 10) : 0;
  const negative = mantissa.startsWith('-');
  const unsigned = mantissa.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = unsigned.split('.');
  let value = BigInt((intPart || '0') + fracPart);
  const scaleDelta = fracPart.length - exp - decimals;
  if (scaleDelta > 0) {
    // Reject silent truncation: 1.1234567899 TON would otherwise settle
    // less than displayed. Caller must round/trim explicitly.
    throw new Error(`Too many decimals for ${decimals}-decimal asset: ${raw}`);
  } else if (scaleDelta < 0) {
    value *= 10n ** BigInt(-scaleDelta);
  }
  return negative ? -value : value;
}

/** Convert a human-readable amount to base units as an integer string (no exponent). */
export function toBaseUnits(amount: number | string, asset: string): string {
  const decimals = ASSET_DECIMALS[asset];
  if (decimals === undefined) throw new Error(`Unsupported asset: ${asset}`);
  return parseToScaled(amount, decimals).toString();
}

/**
 * One pricing function for the whole escrow path (deep module behind Deal).
 *
 * MONEY MODEL: the buyer pays `amount + fee`; the seller receives `amount`;
 * the fee is `amount * feeBps / 10000` (feeBps in basis points, 100 = 1%).
 * `expectedDeposit` is the total that must land in the escrow address before
 * the deposit is confirmed by the listener. All three sites that used to
 * hand-roll these numbers (deal create, deposit verify, payout) read from here.
 */
export function dealPricing(
  amount: number | string,
  asset: string,
  feeBpsRaw: number | string | null | undefined,
): {
  priceBase: bigint;
  feeBase: bigint;
  expectedDeposit: bigint;
  sellerHuman: string;
  feeHuman: string;
} {
  const assetUpper = String(asset || 'TON').toUpperCase();
  const priceBase = BigInt(toBaseUnits(amount, assetUpper));
  const n = Number(feeBpsRaw ?? 100);
  const feeBps = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 100;
  const feeBase = feeBps <= 0 ? 0n : (priceBase * BigInt(Math.min(feeBps, 10000))) / 10000n;
  return {
    priceBase,
    feeBase,
    expectedDeposit: priceBase + feeBase,
    sellerHuman: fromBaseUnits(priceBase, assetUpper),
    feeHuman: fromBaseUnits(feeBase, assetUpper),
  };
}

/** Convert base units back to a human-readable plain decimal string. */
export function fromBaseUnits(v: string | bigint, asset: string): string {
  const decimals = ASSET_DECIMALS[asset];
  if (decimals === undefined) throw new Error(`Unsupported asset: ${asset}`);
  let value = typeof v === 'bigint' ? v : BigInt(v.trim());
  const negative = value < 0n;
  if (negative) value = -value;
  const divisor = 10n ** BigInt(decimals);
  const whole = value / divisor;
  const frac = value % divisor;
  let out = whole.toString();
  if (decimals > 0) {
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    if (fracStr) out += '.' + fracStr;
  }
  return (negative ? '-' : '') + out;
}
