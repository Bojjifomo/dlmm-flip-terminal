#!/usr/bin/env node
import { Command } from "commander";
import { ackPending, bootEnv, flipPosition, runBot, setManual, showStatus } from "./app";
import type { Mode } from "./domain";

bootEnv();

const program = new Command();
program
  .name("meteora-flip")
  .description("Pantau posisi DLMM Meteora lo dan flip bid-ask kalau harga nembus range.")
  .version("0.1.0");

program
  .command("status")
  .description("Lihat posisi, sisi, bin, dan PnL. Nggak kirim tx dan nggak nulis state.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .action(async (opts: { config: string }) => {
    await showStatus(opts.config);
  });

program
  .command("run")
  .description("Loop pantau. Default ngikut mode di config. Default aman: dry-run.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .option("--mode <mode>", "dry-run | alert | auto")
  .option("--once", "sekali polling lalu berhenti")
  .action(async (opts: { config: string; mode?: Mode; once?: boolean }) => {
    await runBot(opts.config, opts.mode, Boolean(opts.once));
  });

program
  .command("flip")
  .argument("<position>", "pubkey posisi")
  .description("Hitung (atau jalankan) flip untuk satu posisi.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .option("--dry-run", "hitung rencana, jangan kirim tx")
  .option("--force", "paksa arah flip walau trigger belum kena")
  .option("--now", "lewatin jendela konfirmasi")
  .action(async (position: string, opts: { config: string; dryRun?: boolean; force?: boolean; now?: boolean }) => {
    await flipPosition(opts.config, position, {
      dryRun: Boolean(opts.dryRun),
      force: Boolean(opts.force),
      now: Boolean(opts.now),
    });
  });

program
  .command("confirm")
  .argument("<position>", "pubkey posisi yang nunggu konfirmasi")
  .description("Izinkan flip yang lagi nunggu di mode alert.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .action((position: string, opts: { config: string }) => {
    setManual(opts.config, position, "confirm");
  });

program
  .command("skip")
  .argument("<position>", "pubkey posisi")
  .description("Batalkan flip yang nunggu. Nggak nanya lagi sampai harga balik ke range.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .action((position: string, opts: { config: string }) => {
    setManual(opts.config, position, "skip");
  });

program
  .command("stale")
  .argument("<position>", "pubkey posisi ask yang nyangkut")
  .argument("<action>", "hold | recenter | cut")
  .description("Jawab ask yang kelamaan di luar range: tahan, geser lagi, atau cut ke SOL.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .action((position: string, action: string, opts: { config: string }) => {
    if (action !== "hold" && action !== "recenter" && action !== "cut") {
      throw new Error("action harus hold, recenter, atau cut");
    }
    setManual(opts.config, position, action);
  });

program
  .command("ack")
  .argument("<position>", "pubkey posisi yang statusnya needs_human")
  .description("Hapus pending yang nyangkut setelah lo beresin manual.")
  .option("-c, --config <path>", "file config", process.env.CONFIG_PATH ?? "config.yaml")
  .action((position: string, opts: { config: string }) => {
    ackPending(opts.config, position);
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
