import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, SystemProgram, Transaction, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { capToBalance } from "../src/decision/math";
import { isExpiredError, sendAndConfirm, signatureConfirmed } from "../src/chain/tx";
import { acquireLock } from "../src/state/store";

function fakeConnection(opts: {
  statuses?: Array<{ err: unknown; confirmationStatus: string } | null>;
  blockHeight?: number;
  confirm?: Array<() => Promise<{ value: { err: unknown } }>>;
}) {
  let sent = 0;
  let confirmCall = 0;
  const conn = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
    sendRawTransaction: async () => `sig${++sent}`,
    confirmTransaction: async () => {
      const fn = opts.confirm?.[confirmCall++];
      return fn ? fn() : { value: { err: null } };
    },
    getSignatureStatuses: async () => ({ value: opts.statuses ?? [null] }),
    getBlockHeight: async () => opts.blockHeight ?? 0,
  };
  return { conn: conn as unknown as Connection, sentCount: () => sent };
}

function dummyTx(payer: Keypair): Transaction {
  return new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  );
}

describe("capToBalance", () => {
  it("nggak pernah ngirim lebih dari saldo wallet", () => {
    expect(capToBalance(3_404_717_368_708n, 1_702_358_684_354n)).toBe(1_702_358_684_354n);
  });
  it("nggak nambah di atas rencana", () => {
    expect(capToBalance(100n, 500n)).toBe(100n);
  });
  it("saldo kosong jadi nol", () => {
    expect(capToBalance(100n, 0n)).toBe(0n);
    expect(capToBalance(0n, 50n)).toBe(0n);
  });
});

describe("signatureConfirmed", () => {
  it("tx yang nggak ketemu dan block height lewat = expired", async () => {
    const { conn } = fakeConnection({ statuses: [null], blockHeight: 200 });
    expect(await signatureConfirmed(conn, "x", "confirmed", 150)).toBe("expired");
  });
  it("masih dalam jendela blockhash = pending", async () => {
    const { conn } = fakeConnection({ statuses: [null], blockHeight: 120 });
    expect(await signatureConfirmed(conn, "x", "confirmed", 150)).toBe("pending");
  });
  it("confirmed tetap confirmed", async () => {
    const { conn } = fakeConnection({ statuses: [{ err: null, confirmationStatus: "confirmed" }] });
    expect(await signatureConfirmed(conn, "x", "confirmed", 150)).toBe("confirmed");
  });
});

describe("sendAndConfirm", () => {
  it("kirim ulang pakai blockhash baru kalau tx kedaluwarsa", async () => {
    const payer = Keypair.generate();
    const expired = Object.assign(new Error("Signature sig1 has expired: block height exceeded."), {
      name: "TransactionExpiredBlockheightExceededError",
    });
    const { conn, sentCount } = fakeConnection({
      statuses: [null],
      confirm: [() => Promise.reject(expired), () => Promise.resolve({ value: { err: null } })],
    });
    const sig = await sendAndConfirm({
      connection: conn,
      tx: dummyTx(payer),
      signers: [payer],
      priorityFeeMicroLamports: 1000,
      computeUnitLimit: 200_000,
      maxAttempts: 3,
    });
    expect(sig).toBe("sig2");
    expect(sentCount()).toBe(2);
  });

  it("nyerah setelah maxAttempts kalau terus kedaluwarsa", async () => {
    const payer = Keypair.generate();
    const expired = () => Promise.reject(new Error("block height exceeded"));
    const { conn } = fakeConnection({ statuses: [null], confirm: [expired, expired] });
    await expect(
      sendAndConfirm({
        connection: conn,
        tx: dummyTx(payer),
        signers: [payer],
        priorityFeeMicroLamports: 0,
        computeUnitLimit: 0,
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/kedaluwarsa/);
  });

  it("isExpiredError kenal pesan web3", () => {
    expect(isExpiredError(new Error("Signature abc has expired: block height exceeded."))).toBe(true);
    expect(isExpiredError(new Error("socket hang up"))).toBe(false);
  });
});

describe("acquireLock", () => {
  it("nolak kalau proses lain yang masih hidup pegang lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const state = join(dir, "state.json");
    writeFileSync(`${state}.lock`, String(process.ppid));
    expect(() => acquireLock(state)).toThrow(/lagi jalan/);
  });
  it("ambil alih lock basi lalu lepas", () => {
    const dir = mkdtempSync(join(tmpdir(), "lock-"));
    const state = join(dir, "state.json");
    writeFileSync(`${state}.lock`, "999999999");
    const release = acquireLock(state);
    expect(existsSync(`${state}.lock`)).toBe(true);
    release();
    expect(existsSync(`${state}.lock`)).toBe(false);
  });
});
