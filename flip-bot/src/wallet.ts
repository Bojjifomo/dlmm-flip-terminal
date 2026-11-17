import { readFileSync, existsSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { decodeBase58 } from "./base58";
import { log } from "./logger";

export interface WalletRef {
  pubkey: PublicKey;
  keypair: Keypair | null;
  source: string;
}

export function loadWallet(configPubkey?: string): WalletRef {
  const path = process.env.WALLET_KEYPAIR_PATH?.trim();
  const base58 = process.env.WALLET_KEYPAIR_BASE58?.trim();
  let keypair: Keypair | null = null;
  let source = "config.walletPubkey";
  if (path) {
    if (!existsSync(path)) throw new Error(`WALLET_KEYPAIR_PATH nggak ketemu: ${path}`);
    keypair = keypairFromFile(path);
    source = "WALLET_KEYPAIR_PATH";
  } else if (base58) {
    keypair = Keypair.fromSecretKey(decodeBase58(base58));
    source = "WALLET_KEYPAIR_BASE58";
  }
  const pubkey = keypair?.publicKey ?? (configPubkey ? new PublicKey(configPubkey) : null);
  if (!pubkey) {
    throw new Error(
      "Butuh walletPubkey di config, atau WALLET_KEYPAIR_PATH / WALLET_KEYPAIR_BASE58. Dry-run cukup pubkey.",
    );
  }
  if (keypair && configPubkey && keypair.publicKey.toBase58() !== configPubkey) {
    throw new Error("Pubkey di config beda sama keypair. Samain biar bot nggak ngurus wallet orang.");
  }
  log.info(`wallet ${pubkey.toBase58()} (${source})`);
  return { pubkey, keypair, source };
}

function keypairFromFile(path: string): Keypair {
  const text = readFileSync(path, "utf8").trim();
  if (text.startsWith("[")) {
    const arr = JSON.parse(text) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(decodeBase58(text));
}

export function requireSigner(wallet: WalletRef): Keypair {
  if (!wallet.keypair) {
    throw new Error("Mode ini butuh keypair. Set WALLET_KEYPAIR_PATH atau WALLET_KEYPAIR_BASE58.");
  }
  return wallet.keypair;
}
