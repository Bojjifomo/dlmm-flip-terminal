// Close one Meteora DLMM position: remove 100% liquidity, claim fees, close the account.
//
//   node close_position.mjs --pool <POOL> --position <POSITION> [--dry-run] [--owner <PUBKEY>]
//   node close_position.mjs --pool <POOL> --position <POSITION> --build --owner <PUBKEY>
//        --build prints {"ok", "txs": [base64]} unsigned, for a wallet (Phantom) to sign and send.
//
// env: SOLANA_RPC_URL (required), DLMM_PRIVATE_KEY or DLMM_KEYPAIR (required unless --dry-run / --build).
// Sending prints one JSON line at the end: {"ok", "position", "signatures": [...]}.
// --dry-run builds the transactions and simulates them without signing or sending.
// Leftover memecoin from the range is NOT swapped to SOL here; sell it yourself (spec: leftovers cost -3.93 SOL).
import { progress } from "./progress.mjs";
import { createRequire } from "node:module";
import { loadSigner } from "./keys.mjs";
import { connectionFor, rpcStats } from "./rpc.mjs";
import { sendLegacy, withLock, guardMain, sleep } from "./txutil.mjs";

// The SDK's ESM build has a broken directory import; its CommonJS build loads fine.
const require = createRequire(import.meta.url);
const DLMMmod = require("@meteora-ag/dlmm");
const { PublicKey, ComputeBudgetProgram } = require("@solana/web3.js");
const BN = require("bn.js");
const DLMM = DLMMmod.default ?? DLMMmod;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const print = o => process.stdout.write(JSON.stringify({ rpc: rpcStats(), ...o }) + "\n");
guardMain(print);
const pool = arg("pool");
const positionAddr = arg("position");
const build = process.argv.includes("--build");
const dryRun = process.argv.includes("--dry-run") || build;
const rpc = process.env.SOLANA_RPC_URL || (build ? "https://api.mainnet-beta.solana.com" : undefined);
if (!pool || !positionAddr || !rpc) {
  console.error("usage: SOLANA_RPC_URL=... node close_position.mjs --pool P --position X [--dry-run] [--owner PUBKEY]");
  process.exit(2);
}

const signer = build ? null : loadSigner();
const owner = signer ? signer.publicKey : arg("owner") ? new PublicKey(arg("owner")) : null;
if (!owner) {
  console.error("need DLMM_PRIVATE_KEY / DLMM_KEYPAIR (or --owner with --dry-run)");
  process.exit(2);
}
if (!dryRun && !signer) {
  console.error("DLMM_PRIVATE_KEY / DLMM_KEYPAIR is required to send");
  process.exit(2);
}

const connection = connectionFor(rpc);  // counts requests (rpc stats in the JSON output)
const positionPk = new PublicKey(positionAddr);
// Already closed (by `monitor --mode auto`, the web, Meteora's site, an earlier run that timed out): that is the
// outcome we wanted, not an error. Meteora's data API lists a position for a while after it is closed.
const exists = async () => !!(await connection.getAccountInfo(positionPk, "confirmed"));
if (!(await exists())) {
  print({ ok: true, position: positionAddr, signatures: [], alreadyClosed: true });
  process.exit(0);
}
const dlmm = await DLMM.create(connection, new PublicKey(pool));
const position = await dlmm.getPosition(positionPk);
const { lowerBinId, upperBinId } = position.positionData;

const buildTxs = async () => {
  const txs = await dlmm.removeLiquidity({
    user: owner,
    position: positionPk,
    fromBinId: lowerBinId,
    toBinId: upperBinId,
    bps: new BN(10_000),
    shouldClaimAndClose: true,
  });
  for (const tx of txs) tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  return txs;
};
const txs = await buildTxs();

if (build) {
  // Built one after another by the wallet; each gets a fresh blockhash and a simulation.
  const out = [];
  for (const tx of txs) {
    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    const sim = await connection.simulateTransaction(tx);
    out.push({ simulate: sim.value.err ? { err: sim.value.err } : "ok",
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") });
  }
  process.stdout.write(JSON.stringify({ rpc: rpcStats(), ok: out.every(o => o.simulate === "ok"), position: positionAddr, bins: [lowerBinId, upperBinId], txs: out }) + "\n");
  process.exit(0);
}
const sigs = [];
console.log(`position ${positionAddr} bins ${lowerBinId}..${upperBinId}: ${txs.length} tx(s)`);
if (!dryRun) {
  // One closer per position at a time (web button, auto exit thread, `monitor --mode auto`).
  try {
    await withLock(`position-${positionAddr}`, async () => {
      for (let round = 0; round < 3; round++) {
        if (!(await exists())) return;                      // closed meanwhile (here or elsewhere)
        const list = round === 0 ? txs : (await dlmm.refetchStates(), await buildTxs());
        try {
          for (const [i, tx] of list.entries()) {
            const sig = await sendLegacy(connection, tx, [signer], { label: `close ${positionAddr.slice(0, 4)}${list.length > 1 ? ` ${i + 1}/${list.length}` : ""}` });
            console.log(`  tx ${i + 1}: ${sig}`);
            sigs.push(sig);
          }
          return;
        } catch (e) {
          await sleep(2000);
          if (!(await exists())) return;                    // it did close: the error was about the wait, not the close
          if (round === 2) throw e;
        }
      }
    }, { waitMs: 180000, onWait: (pid, s) => progress(`posisi ${positionAddr.slice(0, 6)}… lagi dipegang proses lain (pid ${pid}), nunggu ${s}s…`) });
  } catch (e) {
    if (!(await exists())) { print({ ok: true, position: positionAddr, signatures: sigs, alreadyClosed: sigs.length === 0 }); process.exit(0); }
    print({ ok: false, position: positionAddr, signatures: sigs, busy: !!e.busy, error: String(e.message || e).slice(0, 300) });
    process.exit(1);
  }
  print({ ok: true, position: positionAddr, signatures: sigs, ...(sigs.length ? {} : { alreadyClosed: true }) });
  process.exit(0);
}
for (const [i, tx] of txs.entries()) {
  if (dryRun) {
    tx.feePayer = owner;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const sim = await connection.simulateTransaction(tx);
    const err = sim.value.err;
    console.log(`  tx ${i + 1}: simulate ${err ? "ERROR " + JSON.stringify(err) : "ok"} (${tx.instructions.length} ix)`);
    if (err) process.exitCode = 1;
  }
}
