import DLMM from "@meteora-ag/dlmm";
import { Connection, PublicKey } from "@solana/web3.js";

const cache = new Map<string, DLMM>();

export async function loadPool(connection: Connection, pool: string, refresh = false): Promise<DLMM> {
  const hit = cache.get(pool);
  if (hit) {
    if (refresh) await hit.refetchStates();
    return hit;
  }
  const dlmm = await DLMM.create(connection, new PublicKey(pool), { cluster: "mainnet-beta" });
  cache.set(pool, dlmm);
  return dlmm;
}

export function dropPool(pool: string): void {
  cache.delete(pool);
}
