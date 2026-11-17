export function shortPk(value: string, n = 4): string {
  if (value.length <= n * 2 + 1) return value;
  return `${value.slice(0, n)}…${value.slice(-n)}`;
}

export function formatUnits(amount: bigint, decimals: number, maxFrac = 6): string {
  const neg = amount < 0n;
  const v = neg ? -amount : amount;
  const scale = 10n ** BigInt(Math.max(0, decimals));
  const whole = v / scale;
  const frac = v % scale;
  let fracStr = frac.toString().padStart(Math.max(0, decimals), "0").slice(0, maxFrac);
  fracStr = fracStr.replace(/0+$/, "");
  const body = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
  return neg ? `-${body}` : body;
}

export function solscanTx(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

export function solscanAccount(address: string): string {
  return `https://solscan.io/account/${address}`;
}

export function jakartaDate(nowMs: number): string {
  return new Date(nowMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function ageMinutes(fromMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (mins < 60) return `${mins} menit`;
  const h = Math.floor(mins / 60);
  return `${h} jam ${mins % 60} menit`;
}
