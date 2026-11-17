# DLMM Flip Terminal

DLMM Web (Portfolio, Pilih pool, ladder, auto exit, Jual ke SOL, Cleanup) + **bid-ask flip**, plus fixes for the
errors in the old version.

| Folder | Isi |
| --- | --- |
| `dlmm_terminal/` | **App-nya.** DLMM Web (Python) + executor (Node, Meteora SDK). Dari `Capstone1/dlmm_terminal`, udah dibenerin + fitur flip. Detail: [`dlmm_terminal/README.md`](dlmm_terminal/README.md) |
| `flip-bot/` | Bot flip bid-ask versi CLI (TypeScript). Sumber mekanisme flip. Nggak perlu dijalanin kalau pakai DLMM Web |

## Jalanin di Mac

Sekali aja (kalau belum): `brew install python node git`.

```bash
cd ~/Projects/src && git clone https://github.com/Bojjifomo/dlmm-flip-terminal.git
```

```bash
cd ~/Projects/src/dlmm-flip-terminal/dlmm_terminal/executor && npm install
```

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

## Test

```bash
python3 -m unittest discover -s dlmm_terminal/tests -t .
```

```bash
cd dlmm_terminal/executor && node test_ladder.mjs && node test_txutil.mjs && node test_flip.mjs
```

Pakai wallet khusus LP. `.env`, `data/`, dan file key nggak pernah ke-commit (`.gitignore`).
