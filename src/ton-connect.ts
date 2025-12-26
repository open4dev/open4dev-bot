import TonConnect, { IStorage, WalletConnectionSource } from '@tonconnect/sdk';
import QRCode from 'qrcode';

// In-memory storage for TonConnect
const GLOBAL_STORAGE = new Map<string, string>();

class NodeStorage implements IStorage {
  constructor(private namespace: string) {}

  private getKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async removeItem(key: string): Promise<void> {
    GLOBAL_STORAGE.delete(this.getKey(key));
  }

  async setItem(key: string, value: string): Promise<void> {
    GLOBAL_STORAGE.set(this.getKey(key), value);
  }

  async getItem(key: string): Promise<string | null> {
    return GLOBAL_STORAGE.get(this.getKey(key)) ?? null;
  }
}

// TonConnect instances per user
const tonConnectInstances = new Map<number, TonConnect>();
const listenerUnsubscribers = new Map<number, () => void>();
const connectionPollers = new Map<number, NodeJS.Timeout>();

// Manifest URL - must be publicly accessible
const MANIFEST_URL = process.env.TON_CONNECT_MANIFEST_URL || 'https://raw.githubusercontent.com/open4dev/open4dev-bot/main/public/tonconnect-manifest.json';

export interface WalletConnectionData {
  universalLink: string;
  qrCodeBuffer: Buffer;
  tcLink: string;
}

// Wallet configurations
const WALLET_CONFIGS: Record<string, WalletConnectionSource> = {
  'Tonkeeper': {
    bridgeUrl: 'https://bridge.tonapi.io/bridge',
    universalLink: 'https://app.tonkeeper.com/ton-connect',
  },
  'MyTonWallet': {
    bridgeUrl: 'https://bridge.mytonwallet.org/bridge',
    universalLink: 'https://connect.mytonwallet.org/ton-connect',
  },
  'Telegram Wallet': {
    bridgeUrl: 'https://bridge.tonapi.io/bridge',
    universalLink: 'https://t.me/wallet?attach=wallet',
  },
};

/**
 * Get or create TonConnect instance for a user
 */
export function getTonConnectInstance(telegramId: number): TonConnect {
  let connector = tonConnectInstances.get(telegramId);

  if (!connector) {
    connector = new TonConnect({
      manifestUrl: MANIFEST_URL,
      storage: new NodeStorage(`user_${telegramId}`),
    });
    tonConnectInstances.set(telegramId, connector);
  }

  return connector;
}

/**
 * Restore connection from storage
 */
export async function restoreConnection(telegramId: number): Promise<TonConnect> {
  const connector = getTonConnectInstance(telegramId);

  if (!connector.connected) {
    try {
      await connector.restoreConnection();
    } catch (error) {
      console.log(`[TonConnect] Restore failed for user ${telegramId}:`, error);
    }
  }

  return connector;
}

/**
 * Generate wallet connection link and QR code
 */
export async function generateWalletConnection(
  telegramId: number,
  walletType: string,
  onConnected: (address: string) => void,
  onDisconnected: () => void
): Promise<WalletConnectionData> {
  const connector = getTonConnectInstance(telegramId);

  // Cleanup existing connection
  stopConnectionPolling(telegramId);

  const oldUnsubscribe = listenerUnsubscribers.get(telegramId);
  if (oldUnsubscribe) {
    oldUnsubscribe();
    listenerUnsubscribers.delete(telegramId);
  }

  if (connector.connected) {
    await connector.disconnect();
  }

  // Setup listener BEFORE connect
  setupWalletListener(telegramId, onConnected, onDisconnected);

  // Get wallet config and connect
  const walletConfig = WALLET_CONFIGS[walletType] || WALLET_CONFIGS['Tonkeeper'];

  let tcLink: string;
  try {
    const linkOrPromise = connector.connect(walletConfig) as unknown;
    tcLink = typeof linkOrPromise === 'string' ? linkOrPromise : await (linkOrPromise as Promise<string>);
  } catch (error) {
    console.error(`[TonConnect] connect() failed:`, error);
    throw error;
  }

  // Start polling as fallback
  startConnectionPolling(telegramId, onConnected, onDisconnected);

  // Convert to universal link
  const universalLink = convertToUniversalLink(tcLink, walletType);

  // Generate QR code buffer
  const qrCodeBuffer = await QRCode.toBuffer(tcLink, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  return { universalLink, qrCodeBuffer, tcLink };
}

/**
 * Convert tc:// to HTTPS universal link
 */
function convertToUniversalLink(tcLink: string, walletType: string): string {
  const url = new URL(tcLink);
  const params = new URLSearchParams();
  url.searchParams.forEach((value, key) => params.append(key, value));

  switch (walletType) {
    case 'Tonkeeper':
      return `https://app.tonkeeper.com/ton-connect?${params.toString()}`;
    case 'MyTonWallet':
      return `https://connect.mytonwallet.org/ton-connect?connect=${encodeURIComponent(tcLink)}`;
    case 'Telegram Wallet':
      return `https://t.me/wallet?startattach=${encodeURIComponent(params.toString())}`;
    default:
      return `https://app.tonkeeper.com/ton-connect?${params.toString()}`;
  }
}

/**
 * Setup wallet listener
 */
function setupWalletListener(
  telegramId: number,
  onConnected: (address: string) => void,
  onDisconnected: () => void
): void {
  const connector = getTonConnectInstance(telegramId);

  const unsubscribe = connector.onStatusChange(
    (wallet) => {
      if (wallet) {
        stopConnectionPolling(telegramId);
        onConnected(wallet.account.address);
      } else {
        stopConnectionPolling(telegramId);
        onDisconnected();
      }
    },
    (error) => {
      console.error(`[TonConnect] Error for user ${telegramId}:`, error);
      stopConnectionPolling(telegramId);
      onDisconnected();
    }
  );

  listenerUnsubscribers.set(telegramId, unsubscribe);
}

/**
 * Start connection polling (fallback for Node.js)
 */
function startConnectionPolling(
  telegramId: number,
  onConnected: (address: string) => void,
  onDisconnected: () => void
): void {
  stopConnectionPolling(telegramId);

  const connector = tonConnectInstances.get(telegramId);
  if (!connector) return;

  let lastStatus = connector.connected || !!connector.wallet;
  let pollCount = 0;
  const maxPolls = 120; // 2 minutes

  const pollInterval = setInterval(() => {
    pollCount++;
    const currentConnector = tonConnectInstances.get(telegramId);
    if (!currentConnector) {
      stopConnectionPolling(telegramId);
      return;
    }

    const isConnected = currentConnector.connected || !!currentConnector.wallet;
    const address = currentConnector.account?.address || currentConnector.wallet?.account?.address;

    if (isConnected && address && !lastStatus) {
      stopConnectionPolling(telegramId);
      onConnected(address);
      return;
    }

    if (!isConnected && lastStatus) {
      stopConnectionPolling(telegramId);
      onDisconnected();
      return;
    }

    lastStatus = isConnected;

    if (pollCount >= maxPolls) {
      stopConnectionPolling(telegramId);
    }
  }, 1000);

  connectionPollers.set(telegramId, pollInterval);
}

/**
 * Stop connection polling
 */
function stopConnectionPolling(telegramId: number): void {
  const poller = connectionPollers.get(telegramId);
  if (poller) {
    clearInterval(poller);
    connectionPollers.delete(telegramId);
  }
}

/**
 * Check if wallet is connected
 */
export function isWalletConnected(telegramId: number): boolean {
  const connector = tonConnectInstances.get(telegramId);
  return connector ? connector.connected : false;
}

/**
 * Get connected wallet address
 */
export function getWalletAddress(telegramId: number): string | null {
  const connector = tonConnectInstances.get(telegramId);
  if (!connector || !connector.connected) return null;
  return connector.account?.address || null;
}

/**
 * Disconnect wallet
 */
export async function disconnectWallet(telegramId: number): Promise<void> {
  stopConnectionPolling(telegramId);

  const unsubscribe = listenerUnsubscribers.get(telegramId);
  if (unsubscribe) {
    unsubscribe();
    listenerUnsubscribers.delete(telegramId);
  }

  const connector = tonConnectInstances.get(telegramId);
  if (connector) {
    if (connector.connected) {
      await connector.disconnect();
    }
    tonConnectInstances.delete(telegramId);
  }

  // Clean storage
  const namespace = `user_${telegramId}`;
  for (const key of GLOBAL_STORAGE.keys()) {
    if (key.startsWith(namespace + ':')) {
      GLOBAL_STORAGE.delete(key);
    }
  }
}

/**
 * Send transaction via TonConnect
 */
export async function sendTransaction(
  telegramId: number,
  params: {
    address: string;
    amount: string;
    stateInit?: string;
    payload?: string;
  }
): Promise<string> {
  const connector = await restoreConnection(telegramId);

  if (!connector.connected) {
    throw new Error('Wallet not connected');
  }

  const transaction = {
    validUntil: Math.floor(Date.now() / 1000) + 600, // 10 minutes
    messages: [
      {
        address: params.address,
        amount: params.amount,
        stateInit: params.stateInit,
        payload: params.payload,
      },
    ],
  };

  const result = await connector.sendTransaction(transaction);
  return result.boc;
}
