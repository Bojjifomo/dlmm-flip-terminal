# DLMM Flip Terminal

DLMM Web (Portfolio, Pilih pool, ladder, auto exit, Jual ke SOL, Cleanup) + **bid-ask flip**, plus fixes for the
errors in the old version.

| Folder | Isi |
| --- | --- |
| `dlmm_terminal/` | **App-nya.** DLMM Web (Python) + executor (Node, Meteora SDK). Dari `Capstone1/dlmm_terminal`, udah dibenerin + fitur flip. Detail: [`dlmm_terminal/README.md`](dlmm_terminal/README.md) |
| `mac-remote/` | **Mac Remote**: kontrol Mac mini / MacBook Pro dari iPhone (layar + keyboard + trackpad). Detail: [`mac-remote/README.md`](mac-remote/README.md) |
| `flip-bot/` | Bot flip bid-ask versi CLI (TypeScript). Sumber mekanisme flip. Nggak perlu dijalanin kalau pakai DLMM Web |

## Jalanin di Mac

Sekali aja (kalau belum): `brew install python node git`.

```bash
cd ~/Projects/src && git clone https://github.com/Bojjifomo/dlmm-flip-terminal.git
```

```bash
cd ~/Projects/src/dlmm-flip-terminal/dlmm_terminal/executor && npm install
```

**Satu-satunya versi yang dipakai sekarang.** Isinya udah termasuk semua update terakhir dari `Capstone1/dlmm_terminal` (filter dari review wallet, fix re-entry, versi iPhone). `Capstone1/dlmm_terminal` dan repo `dlmm-terminal` jangan dipakai lagi.

`Buka DLMM Web.command` otomatis ngambil `.env` dan `data/` dari versi lama (Capstone1 / dlmm-terminal) kalau di sini belum ada, dan nawarin matiin DLMM Web lama yang masih jalan. Kalau mau manual:

Pindahin `.env` dari versi lama (isinya sama: `DLMM_PRIVATE_KEY`, `SOLANA_RPC_URL`, `DLMM_WEB_PIN`, Telegram):

```bash
cp ~/Projects/src/dlmm-terminal/.env ~/Projects/src/dlmm-flip-terminal/dlmm_terminal/.env
```

Kalau `.env` lama ada di tempat lain, cari dulu pakai `ls ~/Projects/src/dlmm-terminal/.env ~/Capstone1/dlmm_terminal/.env`. Kalau belum ada sama sekali, double-click `Buka DLMM Web.command`; dia bikin `.env` dan buka TextEdit.

Mau bawa settings, watchlist, auto exit, dan log lama juga? Copy folder `data/`:

```bash
cp -R ~/Projects/src/dlmm-terminal/data ~/Projects/src/dlmm-flip-terminal/dlmm_terminal/
```

Stop dulu DLMM Web lama (Ctrl+C di jendela Terminal-nya). Kalau ada `monitor --mode auto` yang jalan, stop juga lalu jalanin lagi dari folder baru. Habis itu:

```bash
cd ~/Projects/src/dlmm-flip-terminal && python3 -m dlmm_terminal web
```

Atau double-click `dlmm_terminal/Buka DLMM Web.command`. Buka http://localhost:8891.

## Yang baru

- **Flip bid-ask per pool** di Portfolio: `flip: off / alert / auto`. Slice SOL yang ketembus harga dibuka lagi jadi token di atas harga, lalu balik jadi SOL di bawah harga. Lihat [README dlmm_terminal → Bid-ask flip](dlmm_terminal/README.md#bid-ask-flip-baru-dari-flip-bot).
- **Error di versi lama dibenerin**: jual token "insufficient funds", auto exit "Position account not found", "block height exceeded", token BAWSAQ yang nyangkut, tombol Jual di token tanpa harga. Lihat [tabel perbaikan](dlmm_terminal/README.md#perbaikan-dari-versi-lama-error-di-portfolio).
- **📊 Review** (Portfolio): ladder lu N hari terakhir per koin (fee vs rugi harga), dan tiap aturan filter: PnL yang lolos vs yang ditolak, plus tetap menang atau nggak kalau satu koin dikeluarin. Meteora API, 0 RPC.
- **Filter dari review Nov 2026**: harga naik > +5% dalam 1 jam = WAIT. Flag: pool < 6 jam, vol 24h ÷ mcap di luar 0.3–3×, bin step > 100. Semua bisa diubah di ⚙ Settings.
- **Re-entry**: tetap buka ladder lagi walau token gagal dijual (token ditinggal buat Cleanup), nunggu saldo SOL kebaca, dan sebelum konfirmasi nunjukin entry check pool itu sekarang (web + iPhone).

## Test

```bash
python3 -m unittest discover -s dlmm_terminal/tests -t .
```

```bash
node dlmm_terminal/scriptable/tests/test_dlmm_rules.mjs
```

```bash
cd dlmm_terminal/executor && node test_ladder.mjs && node test_txutil.mjs && node test_flip.mjs
```

Pakai wallet khusus LP. `.env`, `data/`, dan file key nggak pernah ke-commit (`.gitignore`).
