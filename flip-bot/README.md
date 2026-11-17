# meteora-bidask-flip

Bot TypeScript buat ngawasin posisi DLMM lo di Meteora, terus nge-flip otomatis pakai strategi **bid-ask**.

Lo buka posisi sendiri di [app.meteora.ag](https://app.meteora.ag). Bot ini nggak buka posisi dari nol. Dia lihat wallet lo, ngerti posisinya lagi bid atau ask, dan pindahin likuiditasnya kalau harga udah nembus range.

Default-nya **dry-run**: ngitung dan nulis rencana, nggak ngirim transaksi.

## Cara kerjanya

Di DLMM, harga naik seiring bin id.

- **Bid** = cuma token Y (biasanya SOL) di **bawah** harga. Bentuk BidAsk: bobot lebih berat di tepi bawah, jadi kalau harga nyentuh, lo beli lebih banyak di harga yang lebih rendah.
- Trigger flip: posisi udah **~99% token** (base), **atau** bin aktif benar-benar di luar range ke arah fill. Bukan cuma hitungan poll: harga harus stay di situ selama `confirmMinutes` (default 4 menit, di antara 3–5).
- Bot claim fee, cabut 100% likuiditas, tutup posisi, buka posisi **baru** selebar **jumlah bin yang sama**, cuma token X, BidAsk di **atas** harga. Fee yang baru di-claim ikut dideposit (compound). Bobot lebih berat di tepi atas.
- Kebalikannya sama. Ask yang ketembus ke atas (posisi balik jadi SOL) di-flip lagi jadi bid SOL di bawah harga.

Bot inget sisi tiap posisi. Ask yang baru lo buka (token di atas harga) **nggak** langsung di-flip. Itu beda sama bid yang udah ke-fill. Lihat `adoptOutOfRange` dan `initialSide` di config.

TP: modal diukur dalam token quote (SOL kalau pool-nya TOKEN/SOL) pas bot pertama kali ngadopsi posisi. TP nyala cuma setelah nilai principal sempat turun (ada IL), lalu balik ke minimal modal + buffer. Artinya IL-nya udah balik, untung lo kira-kira fee.

- `tpMode: keep_cycling` — kabarin doang, tetap flip.
- `tpMode: close` — cabut, swap base ke quote lewat pool yang sama, berhenti.

## Cara main yang baik

Ini ringkasan cara trader main bid-ask flip, dan semua angkanya bisa lo ganti di config.

1. Buka sendiri posisi **satu sisi**, SOL doang, strategi BidAsk, **di bawah harga**. Lebar yang biasa dipakai **70 bin**. Bin step yang enak **80 atau 100**. Step lain cuma di-warning, nggak diblokir.
2. Biarkan harga turun masuk range. Bobotnya lebih berat di tepi bawah, jadi lo beli lebih banyak pas harga udah lebih murah.
3. Flip kalau salah satu ini stay selama jendela konfirmasi (default **4 menit**, plus minimal 2 cek):
   - isi posisi sudah **>= 99% token**, atau
   - bin aktif sudah **sepenuhnya di luar** range (harga nembus ujung).
4. Bot claim fee dulu, tutup posisi, buka ask token-only **dengan jumlah bin yang sama** di atas harga. Modal yang tersisa di-compound. Sisa SOL di wallet nggak disentuh (`minSolReserveLamports`). Masih ada batas flip per 24 jam.
5. Kebalikannya sama: ask yang jadi ~100% SOL, atau harga nembus atas range, dibalik jadi bid SOL di bawah.
6. `gradualFlip` **mati** by default. Kalau dinyalain, tiap harga geser `gradualFlipBins` (default 20, enak di 15–30) bot ngupas potongan itu dan buka sisi lawan selebar potongan, sisa posisinya tetap.
7. Kesehatan pool: fee 24 jam / TVL. Kalau harga lagi di **tengah** range dan rasio itu di bawah `minFeeTvl` (default **20%**), bot `alert` atau `pause` sesuai `feeTvlAction`. 20% itu tinggi; turunin kalau lo cuma mau buang pool yang beneran mati. TVL di atas **$100rb** cuma peringatan, karena fee share lo kegencet.
8. Token dengan **transfer tax** (Token-2022 transfer fee) dan pool yang SOL-nya di mint X di-skip.
9. Ask yang bot buka lalu harga jatuh di bawahnya dan fee nol selama `staleAskHours` (default **12 jam**): bot cuma **ngabarin**. Pilihan lo: `hold`, `recenter` (geser ask, lebar tetap), atau `cut` (tutup dan swap ke SOL). Perintahnya `meteora-flip stale <posisi> hold|recenter|cut`, atau tombol Telegram.
10. Filter token ini **saran doang**, muncul di `status` dan notif, nggak nahan flip: mcap di bawah **$1jt**, umur pool di bawah **2 hari**, harga jauh dari ATH (turun lebih dari 30%). Kalau DexScreener / API Meteora nggak ngasih angkanya, cek itu dilewatin.

## Setup

Butuh Node 20+.

```bash
npm install
cp .env.example .env
cp config/sample.config.yaml config.yaml
```

Isi `config.yaml`:

- `walletPubkey` — pubkey hot wallet LP lo. Dry-run dan `status` cukup ini.
- `watch: all` ngurus semua posisi. Isi `pools` kalau cuma mau pool tertentu.
- Override per pool/posisi: `rangeWidthBins`, `initialSide`, `tpMode`, `slippageBps`, dll. Contoh ada di sample.

`.env`:

| Variabel | Wajib? | Buat apa |
| --- | --- | --- |
| `RPC_URL` | alert/auto wajib | Helius / Triton / QuickNode. Public RPC cuma buat dry-run dan sering nolak `getProgramAccounts`. |
| `WALLET_KEYPAIR_PATH` | auto/alert | File `solana-keygen` (JSON array) atau base58. |
| `WALLET_KEYPAIR_BASE58` | alternatif | Jangan di-commit. Nggak pernah di-log. |
| `TELEGRAM_BOT_TOKEN` | opsional | Notif flip, TP, error, ringkasan harian (WIB). |
| `TELEGRAM_CHAT_ID` | opsional | Chat yang boleh pencet tombol. |

Pakai **hot wallet khusus modal LP**. Jangan wallet utama. SOL di wallet kepake buat rent posisi, bin array, dan priority fee. `minSolReserveLamports` (default 0.05 SOL) nggak boleh kesentuh.

## Jalanin

```bash
npm run build
node dist/cli.js status --config config.yaml
node dist/cli.js run --mode dry-run --once --config config.yaml
node dist/cli.js run --mode dry-run --config config.yaml
node dist/cli.js flip <POSITION_PUBKEY> --dry-run --config config.yaml
```

Mode:

- `dry-run` — rencana doang.
- `alert` — Telegram ada tombol Gas flip / Skip, atau `node dist/cli.js confirm <posisi>` / `skip <posisi>`.
- `auto` — kirim tx sendiri.

`flip` tanpa `--dry-run` ngikut mode config. `--now` lewatin jendela konfirmasi. `--force` paksa arahnya; hati-hati.

Kalau deposit lebar nyangkut di tengah, bot berhenti (`needs_human`) biar nggak dobel. Beresin manual, lalu `node dist/cli.js ack <posisi>`.

State ada di `.state/bot-state.json` (mode 0600). File ini nyimpen cost basis dan, pas lagi flip, **secret key posisi baru**. Jangan di-commit, jangan di-share.

### Mac, launchd

`deploy/com.meteora.bidask-flip.plist` contohnya. Ganti path, terus:

```bash
cp deploy/com.meteora.bidask-flip.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.meteora.bidask-flip.plist
launchctl start com.meteora.bidask-flip
```

Log di `/tmp/meteora-bidask-flip.log`.

### VPS, pm2

```bash
npm run build
pm2 start deploy/ecosystem.config.cjs
pm2 save
```

## Risiko

- Token terus turun: flip ask ninggalin lo pegang token. Pause `maxDropBelowAskBottomPct` cuma berhentiin bot, nggak ngjualin token lo.
- Rent posisi + bin array bisa lebih gede dari fee kalau range lebar dan flip sering. Ada `maxFlipsPer24h`.
- RPC telat / `getProgramAccounts` ditolak: bot bisa telat liat posisi. Discovery utama lewat Data API Meteora, terus saldo dibaca on-chain. API bisa telat beberapa detik.
- Slippage dan priority fee tetep bisa bikin tx gagal pas jaringan rame.
- IL bisa lebih gede dari fee kalau harga nggak balik. TP nggak ngejamin untung.
- Ini bukan nasihat keuangan. Lo yang tanggung modalnya.

## SDK yang dipakai

`@meteora-ag/dlmm@1.9.14` + `@solana/web3.js`.

Yang diverifikasi di source SDK, bukan tebakan:

- `DLMM.create`, `getPositionsByUserAndLbPair`, `DLMM.getAllLbPairPositionsByUser`, `getPosition`
- `claimAllRewardsByPosition` (lempar `"No fee/reward to claim"` kalau kosong). `claimAllRewards` itu buat banyak posisi.
- `removeLiquidity({ fromBinId, toBinId, bps, shouldClaimAndClose })` — `bps = 10000` artinya 100%.
- `closePosition({ owner, position })`
- `initializePositionAndAddLiquidityByStrategy` dengan `StrategyType.BidAsk`
- `swap` / `swapQuote` (slippage swap dalam **bps**)

Catatan penting:

- Parameter `slippage` di liquidity itu **persen** (1 = 1%), di-cap 0–100. Config bot pakai bps, terus dibagi 100 sebelum masuk SDK.
- `initializePosition` cuma sampai **70 bin** (`DEFAULT_BIN_PER_POSITION`). Lebih dari itu bot bikin posisi kosong 70 bin, `increasePositionLength` (max 1400, `POSITION_MAX_LENGTH`), lalu `addLiquidityByStrategyChunkable`.
- BidAsk one-sided terjadi karena rangenya ditaruh sepenuhnya di atas atau di bawah bin aktif (gap minimal 1) dan cuma satu token yang dideposit. Distribusi SDK: ask (`toWeightAscendingOrder`) lebih berat di tepi atas, bid (`toWeightDescendingOrder`) lebih berat di tepi bawah.
- Pool yang SOL-nya di mint X di-skip, kecuali `allowInvertedQuote: true`. Bin di bawah harga selalu token Y.

## Dev

```bash
npm test
npm run typecheck
```

Logika keputusan (trigger, konfirmasi, TP, range) ada di `src/decision` dan nggak nyentuh RPC. Tesnya di `test/`.
