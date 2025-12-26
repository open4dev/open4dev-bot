# Open4Dev NFT Minter Bot

Telegram bot for minting Open4Dev Club NFTs on TON blockchain with TON Connect wallet integration.

## Features

- TON Connect wallet integration (Tonkeeper, MyTonWallet, Telegram Wallet)
- QR code for wallet connection
- Direct transaction signing via connected wallet
- Full mint flow within Telegram

## Prerequisites

- Node.js 18+
- Running NFT Minter service (see [nft-minter-tolk](https://github.com/AlibekIrgash/nft-minter-tolk))
- Telegram Bot Token from [@BotFather](https://t.me/BotFather)

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
BOT_TOKEN=your_telegram_bot_token
MINTER_SERVICE_URL=http://localhost:3000
TON_CONNECT_MANIFEST_URL=https://your-domain.com/tonconnect-manifest.json
DEFAULT_METADATA_URL=https://example.com/nft/open4dev.json
DEFAULT_PRICE=0.01
```

### 3. Start the Bot

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start bot, connect wallet |
| `/status` | Check minting service status |
| `/help` | Show help message |

## User Flow

```
/start
  ↓
[Connect Wallet] → Select wallet (Tonkeeper/MyTonWallet/Telegram)
  ↓
QR Code + "Open Wallet" button
  ↓
User connects wallet
  ↓
[Mint NFT] → Prepare mint data
  ↓
[Confirm Mint] → Sign transaction in wallet
  ↓
NFT minted!
```

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Telegram Bot │────▶│ Minting Service  │────▶│ TON Blockchain  │
└──────────────┘     └──────────────────┘     └─────────────────┘
       │                                              ▲
       │ TON Connect                                  │
       ▼                                              │
┌──────────────────┐                                  │
│ User Wallet      │──────────────────────────────────┘
│ (Tonkeeper, etc) │  Signs & sends transaction
└──────────────────┘
```

## Project Structure

```
├── src/
│   ├── index.ts          # Main bot with grammY
│   ├── ton-connect.ts    # TON Connect integration
│   ├── minter-service.ts # Minting service API client
│   ├── ton-link.ts       # TON transaction utilities
│   └── types.ts          # TypeScript types
├── public/
│   └── tonconnect-manifest.json  # TON Connect app manifest
├── .env.example
├── package.json
└── tsconfig.json
```

## TON Connect Manifest

The `tonconnect-manifest.json` must be publicly accessible. It identifies your app to wallets:

```json
{
  "url": "https://t.me/your_bot",
  "name": "Open4Dev NFT Minter",
  "iconUrl": "https://your-domain.com/icon.png"
}
```

Host it on GitHub Pages, your own server, or use raw GitHub URL.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `BOT_TOKEN` | Telegram bot token | Required |
| `MINTER_SERVICE_URL` | URL of minting service | `http://localhost:3000` |
| `TON_CONNECT_MANIFEST_URL` | Public URL to manifest | Required |
| `DEFAULT_METADATA_URL` | NFT metadata JSON URL | - |
| `DEFAULT_PRICE` | Price in TON | `0.01` |

## Supported Wallets

- **Tonkeeper** - Popular TON wallet
- **MyTonWallet** - Web & browser extension wallet
- **Telegram Wallet** - Built-in Telegram wallet

## License

MIT
