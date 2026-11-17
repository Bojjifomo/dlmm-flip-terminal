import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  type Commitment,
  type TransactionInstruction,
} from "@solana/web3.js";

const PRICE_TAG = 3;

export function withPriorityFee(tx: Transaction, microLamports: number, computeUnitLimit: number): Transaction {
  const kept: TransactionInstruction[] = [];
  let hasLimit = false;
  for (const ix of tx.instructions) {
    if (isComputePrice(ix)) continue;
    if (isComputeLimit(ix)) hasLimit = true;
    kept.push(ix);
  }
  const next = new Transaction();
  if (microLamports > 0) {
    next.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  }
  if (!hasLimit && computeUnitLimit > 0) {
    next.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  }
  for (const ix of kept) next.add(ix);
  next.feePayer = tx.feePayer;
  return next;
}

function isComputePrice(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === PRICE_TAG;
}

function isComputeLimit(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2;
}

export async function sendAndConfirm(args: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
  priorityFeeMicroLamports: number;
  computeUnitLimit: number;
  maxAttempts: number;
  commitment?: Commitment;
  onSignature?: (signature: string) => void;
}): Promise<string> {
  const commitment = args.commitment ?? "confirmed";
  let lastError: unknown;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    const { blockhash, lastValidBlockHeight } = await args.connection.getLatestBlockhash(commitment);
    const tx = withPriorityFee(args.tx, args.priorityFeeMicroLamports, args.computeUnitLimit);
    tx.recentBlockhash = blockhash;
    tx.feePayer = args.signers[0].publicKey;
    tx.sign(...args.signers);
    const sim = await args.connection.simulateTransaction(tx);
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-25).join("\n");
      throw new Error(`simulasi gagal: ${JSON.stringify(sim.value.err)}\n${logs}`);
    }
    let signature: string;
    try {
      signature = await args.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 2,
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableSend(error) || attempt === args.maxAttempts) throw error;
      continue;
    }
    args.onSignature?.(signature);
    try {
      const result = await args.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        commitment,
      );
      if (result.value.err) {
        throw new Error(`tx ${signature} gagal: ${JSON.stringify(result.value.err)}`);
      }
      return signature;
    } catch (error) {
      if (String(error).includes(`tx ${signature} gagal`)) throw error;
      return signature;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("kirim tx gagal");
}

export async function signatureConfirmed(
  connection: Connection,
  signature: string,
  commitment: Commitment = "confirmed",
): Promise<"confirmed" | "failed" | "pending"> {
  const status = await connection.getSignatureStatuses([signature]);
  const row = status.value[0];
  if (!row) return "pending";
  if (row.err) return "failed";
  if (row.confirmationStatus === "confirmed" || row.confirmationStatus === "finalized") return "confirmed";
  if (commitment === "processed" && row.confirmationStatus === "processed") return "confirmed";
  return "pending";
}

function isRetryableSend(error: unknown): boolean {
  const text = String(error).toLowerCase();
  return (
    text.includes("blockhash") ||
    text.includes("block height") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("node is behind") ||
    text.includes("too many requests")
  );
}
