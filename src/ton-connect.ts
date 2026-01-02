import TonConnect, { IStorage, WalletConnectionSource } from '@tonconnect/sdk';
import QRCode from 'qrcode';
import Redis from 'ioredis';
import { Address } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

// Redis client (lazy initialized)
let redisClient: Redis | null = null;

function getRedisClient(): Redis {
  if (!redisClient) {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisClient = new Redis(redisUrl);
    redisClient.on('error', (err) => console.error('[Redis] Error:', err));
    redisClient.on('connect', () => console.log('[Redis] Connected'));
  }
  return redisClient;
}

// File-based storage path for persistence
const STORAGE_FILE = path.join(process.cwd(), '.tonconnect-sessions.json');

// Load storage from file on startup
function loadStorageFromFile(): Map<string, string> {
  try {
    if (fs.existsSync(STORAGE_FILE)) {
      const data = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      console.log(`[Storage] Loaded ${Object.keys(parsed).length} keys from file`);
      return new Map(Object.entries(parsed));
    }
  } catch (error) {
    console.error('[Storage] Error loading from file:', error);
  }
  return new Map();
}

// Save storage to file
function saveStorageToFile(storage: Map<string, string>): void {
  try {
    const obj = Object.fromEntries(storage);
    fs.writeFileSync(STORAGE_FILE, JSON.stringify(obj, null, 2));
  } catch (error) {
    console.error('[Storage] Error saving to file:', error);
  }
}

// File-backed storage for TonConnect (persists across restarts)
const GLOBAL_STORAGE = loadStorageFromFile();

// Check if Redis should be used
const useRedis = process.env.USE_REDIS === 'true' || !!process.env.REDIS_URL;
console.log(`[TonConnect] Storage mode: ${useRedis ? 'Redis' : 'File'} (USE_REDIS=${process.env.USE_REDIS}, REDIS_URL=${process.env.REDIS_URL ? 'set' : 'unset'})`);

class NodeStorage implements IStorage {
  constructor(private namespace: string) {}

  private getKey(key: string): string {
    return `${this.namespace}:${key}`;
  }

  async removeItem(key: string): Promise<void> {
    const fullKey = this.getKey(key);
    console.log(`[Storage] REMOVE ${fullKey}`);
    GLOBAL_STORAGE.delete(fullKey);
    saveStorageToFile(GLOBAL_STORAGE);
  }

  async setItem(key: string, value: string): Promise<void> {
    const fullKey = this.getKey(key);
    console.log(`[Storage] SET ${fullKey}`);
    GLOBAL_STORAGE.set(fullKey, value);
    saveStorageToFile(GLOBAL_STORAGE);
  }

  async getItem(key: string): Promise<string | null> {
    const fullKey = this.getKey(key);
    const value = GLOBAL_STORAGE.get(fullKey) ?? null;
    console.log(`[Storage] GET ${fullKey} = ${value ? 'EXISTS' : 'NULL'}`);
    return value;
  }
}

class RedisStorage implements IStorage {
  constructor(private namespace: string) {}

  private getKey(key: string): string {
    return `tonconnect:${this.namespace}:${key}`;
  }

  async removeItem(key: string): Promise<void> {
    try {
      const fullKey = this.getKey(key);
      await getRedisClient().del(fullKey);
      console.log(`[RedisStorage] REMOVE ${fullKey}`);
    } catch (error) {
      console.error('[RedisStorage] removeItem error:', error);
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      const fullKey = this.getKey(key);
      // Store without expiration to persist sessions across restarts
      await getRedisClient().set(fullKey, value);
      console.log(`[RedisStorage] SET ${fullKey}`);
    } catch (error) {
      console.error('[RedisStorage] setItem error:', error);
    }
  }

  async getItem(key: string): Promise<string | null> {
    try {
      const fullKey = this.getKey(key);
      const value = await getRedisClient().get(fullKey);
      console.log(`[RedisStorage] GET ${fullKey} = ${value ? 'EXISTS' : 'NULL'}`);
      return value;
    } catch (error) {
      console.error('[RedisStorage] getItem error:', error);
      return null;
    }
  }
}

// Create storage based on configuration
function createStorage(telegramId: number): IStorage {
  const namespace = `user_${telegramId}`;
  if (useRedis) {
    console.log(`[TonConnect] Using Redis storage for user ${telegramId}`);
    return new RedisStorage(namespace);
  }
  console.log(`[TonConnect] Using file-backed storage for user ${telegramId}`);
  return new NodeStorage(namespace);
}

/**
 * Convert address to user-friendly bounceable format required by TonConnect SDK
 */
function toUserFriendlyAddress(address: string): string {
  try {
    const parsed = Address.parse(address);
    return parsed.toString({ bounceable: true });
  } catch {
    return address;
  }
}

// TonConnect instances per user
const tonConnectInstances = new Map<number, TonConnect>();
const listenerUnsubscribers = new Map<number, () => void>();
const connectionPollers = new Map<number, NodeJS.Timeout>();
const connectionCallbacks = new Map<number, {
  onConnected: (address: string) => void;
  onDisconnected: () => void;
}>();

// Manifest URL - must be publicly accessible
const MANIFEST_URL = process.env.TON_CONNECT_MANIFEST_URL || 'https://raw.githubusercontent.com/open4dev/open4dev-bot/main/public/tonconnect-manifest.json';

export interface WalletConnectionData {
  universalLink: string;
  qrCodeBuffer: Buffer;
  tcLink: string;
}

// Wallet configurations (from https://github.com/ton-connect/wallets-list)
const WALLET_CONFIGS: Record<string, WalletConnectionSource> = {
  'Tonkeeper': {
    bridgeUrl: 'https://bridge.tonapi.io/bridge',
    universalLink: 'https://app.tonkeeper.com/ton-connect',
  },
  'MyTonWallet': {
    bridgeUrl: 'https://tonconnectbridge.mytonwallet.org/bridge/',
    universalLink: 'https://connect.mytonwallet.org',
  },
  'Telegram Wallet': {
    bridgeUrl: 'https://walletbot.me/tonconnect-bridge/bridge',
    universalLink: 'https://t.me/wallet?attach=wallet',
  },
};

/**
 * Get or create TonConnect instance for a user
 */
export function getTonConnectInstance(telegramId: number): TonConnect {
  let connector = tonConnectInstances.get(telegramId);

  if (!connector) {
    console.log(`[getTonConnectInstance] Creating new instance for user ${telegramId}`);
    connector = new TonConnect({
      manifestUrl: MANIFEST_URL,
      storage: createStorage(telegramId),
    });
    tonConnectInstances.set(telegramId, connector);
  } else {
    console.log(`[getTonConnectInstance] Reusing existing instance for user ${telegramId}`);
  }

  return connector;
}

/**
 * Restore connection from storage
 */
export async function restoreConnection(telegramId: number): Promise<TonConnect> {
  const connector = getTonConnectInstance(telegramId);

  if (!connector.connected) {
    console.log(`[restoreConnection] Attempting to restore connection for user ${telegramId}`);
    try {
      await connector.restoreConnection();
      console.log(`[restoreConnection] Restore result - connected: ${connector.connected}`);
    } catch (error) {
      console.log(`[restoreConnection] Restore failed for user ${telegramId}:`, error);
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

  console.log(`[generateWalletConnection] Starting wallet connection for user ${telegramId}, type: ${walletType}`);

  // STEP 1: Clean up any existing connection and listener
  try {
    stopConnectionPolling(telegramId);

    const oldUnsubscribe = listenerUnsubscribers.get(telegramId);
    if (oldUnsubscribe) {
      console.log(`[generateWalletConnection] Removing old listener for user ${telegramId}`);
      oldUnsubscribe();
      listenerUnsubscribers.delete(telegramId);
    }

    if (connector.connected) {
      console.log(`[generateWalletConnection] Disconnecting existing connection for user ${telegramId}`);
      await connector.disconnect();
    }
  } catch (error) {
    console.log(`[generateWalletConnection] Cleanup error (non-critical):`, error);
  }

  // STEP 2: Setup listener BEFORE calling connect()
  console.log(`[generateWalletConnection] Setting up listener BEFORE connect() for user ${telegramId}`);
  setupWalletListener(telegramId, onConnected, onDisconnected);

  // STEP 3: Get wallet config and connect
  const walletConfig = WALLET_CONFIGS[walletType] || WALLET_CONFIGS['Tonkeeper'];

  console.log(`[generateWalletConnection] Calling connect() for user ${telegramId} (wallet=${walletType}, manifest=${MANIFEST_URL})`);

  let tcLink: string;
  try {
    const linkOrPromise = connector.connect(walletConfig) as unknown;
    tcLink = typeof linkOrPromise === 'string' ? linkOrPromise : await (linkOrPromise as Promise<string>);
  } catch (error) {
    console.error(`[generateWalletConnection] connect() failed:`, error);
    throw error;
  }

  console.log(`[generateWalletConnection] Generated TonConnect link:`, tcLink);

  // STEP 4: Start polling (fallback for Node.js environments)
  startConnectionPolling(telegramId, onConnected, onDisconnected);

  // Convert to universal link
  const universalLink = convertToUniversalLink(tcLink, walletType);
  console.log(`[generateWalletConnection] Universal link:`, universalLink);

  // Generate QR code buffer
  const qrCodeBuffer = await QRCode.toBuffer(tcLink, {
    width: 400,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });

  console.log(`[generateWalletConnection] QR code generated successfully`);

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
      return `https://connect.mytonwallet.org?connect=${encodeURIComponent(tcLink)}`;
    case 'Telegram Wallet':
      return `https://t.me/wallet?startattach=${encodeURIComponent(params.toString())}`;
    default:
      return `https://app.tonkeeper.com/ton-connect?${params.toString()}`;
  }
}

/**
 * Setup wallet listener with error handling
 */
function setupWalletListener(
  telegramId: number,
  onConnected: (address: string) => void,
  onDisconnected: () => void
): void {
  const connector = getTonConnectInstance(telegramId);

  console.log(`[setupWalletListener] Setting up listener for user ${telegramId}`);
  console.log(`[setupWalletListener] Current connection status: ${connector.connected}`);

  // Store callbacks for manual triggering
  connectionCallbacks.set(telegramId, { onConnected, onDisconnected });

  // Remove old listener if exists
  const oldUnsubscribe = listenerUnsubscribers.get(telegramId);
  if (oldUnsubscribe) {
    console.log(`[setupWalletListener] WARNING: Old listener still exists, removing`);
    oldUnsubscribe();
    listenerUnsubscribers.delete(telegramId);
  }

  // Setup new listener with error handling
  const unsubscribe = connector.onStatusChange(
    (wallet) => {
      console.log(`[onStatusChange] Status change triggered for user ${telegramId}`);
      console.log(`[onStatusChange] Wallet data:`, wallet);

      try {
        if (wallet) {
          console.log(`[onStatusChange] ✅ Wallet CONNECTED: ${wallet.account.address}`);
          stopConnectionPolling(telegramId);
          onConnected(wallet.account.address);
        } else {
          console.log(`[onStatusChange] ❌ Wallet DISCONNECTED`);
          stopConnectionPolling(telegramId);
          onDisconnected();
        }
      } catch (error) {
        console.error(`[onStatusChange] Error in callback:`, error);
      }
    },
    (error) => {
      console.error(`[onStatusChange] TonConnect error for user ${telegramId}:`, error);
      try {
        stopConnectionPolling(telegramId);
        onDisconnected();
      } catch (err) {
        console.error(`[onStatusChange] Error calling onDisconnected:`, err);
      }
    }
  );

  listenerUnsubscribers.set(telegramId, unsubscribe);
  console.log(`[setupWalletListener] ✅ Listener set up successfully for user ${telegramId}`);
}

/**
 * Start polling connection status (fallback for Node.js)
 */
function startConnectionPolling(
  telegramId: number,
  onConnected: (address: string) => void,
  onDisconnected: () => void
): void {
  stopConnectionPolling(telegramId);

  console.log(`[startConnectionPolling] Starting connection polling for user ${telegramId}`);

  const connector = tonConnectInstances.get(telegramId);
  if (!connector) {
    console.log(`[startConnectionPolling] Connector not found for user ${telegramId}`);
    return;
  }

  // Initialize lastStatus based on current state
  let lastStatus = connector.connected || !!connector.wallet;
  let pollCount = 0;
  const maxPolls = 120; // 2 minutes

  const pollInterval = setInterval(async () => {
    pollCount++;
    const currentConnector = tonConnectInstances.get(telegramId);

    if (!currentConnector) {
      console.log(`[startConnectionPolling] Connector not found, stopping poll`);
      stopConnectionPolling(telegramId);
      return;
    }

    try {
      const connected = currentConnector.connected;
      const wallet = currentConnector.wallet;
      const account = currentConnector.account;
      const isConnected = connected || !!wallet;
      const currentAddress = account?.address || wallet?.account?.address;

      // Log every 10 polls for debugging
      if (pollCount % 10 === 0) {
        console.log(`[startConnectionPolling] Poll #${pollCount} for user ${telegramId}:`, {
          connected,
          hasWallet: !!wallet,
          hasAccount: !!account,
          address: currentAddress || 'none',
          lastStatus,
          isConnected,
        });
      }

      // Status changed from disconnected to connected
      if (isConnected && currentAddress && !lastStatus) {
        console.log(`[startConnectionPolling] ✅ Connection detected via polling: ${currentAddress}`);
        stopConnectionPolling(telegramId);
        onConnected(currentAddress);
        return;
      }

      // Status changed from connected to disconnected
      if (!isConnected && lastStatus) {
        console.log(`[startConnectionPolling] ❌ Disconnection detected via polling`);
        stopConnectionPolling(telegramId);
        onDisconnected();
        return;
      }

      lastStatus = isConnected;

      if (pollCount >= maxPolls) {
        console.log(`[startConnectionPolling] Max polls reached, stopping`);
        stopConnectionPolling(telegramId);
      }
    } catch (error) {
      console.error(`[startConnectionPolling] Error:`, error);
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
    console.log(`[stopConnectionPolling] Stopped polling for user ${telegramId}`);
  }
}

/**
 * Check if wallet is connected
 */
export function isWalletConnected(telegramId: number): boolean {
  const connector = tonConnectInstances.get(telegramId);
  const connected = connector ? (connector.connected || !!connector.wallet) : false;
  console.log(`[isWalletConnected] User ${telegramId}: ${connected}`);
  return connected;
}

/**
 * Get connected wallet address (in user-friendly format)
 */
export function getWalletAddress(telegramId: number): string | null {
  const connector = tonConnectInstances.get(telegramId);
  if (!connector) {
    console.log(`[getWalletAddress] No connector for user ${telegramId}`);
    return null;
  }

  const connected = connector.connected || !!connector.wallet;
  if (!connected) {
    console.log(`[getWalletAddress] User ${telegramId} not connected`);
    return null;
  }

  const rawAddress = connector.account?.address || connector.wallet?.account?.address;
  if (!rawAddress) {
    console.log(`[getWalletAddress] No address found for user ${telegramId}`);
    return null;
  }

  // Convert to user-friendly format
  const userFriendly = toUserFriendlyAddress(rawAddress);
  console.log(`[getWalletAddress] User ${telegramId}: ${rawAddress} -> ${userFriendly}`);
  return userFriendly;
}

/**
 * Disconnect wallet
 */
export async function disconnectWallet(telegramId: number): Promise<void> {
  console.log(`[disconnectWallet] Disconnecting user ${telegramId}`);

  stopConnectionPolling(telegramId);

  const unsubscribe = listenerUnsubscribers.get(telegramId);
  if (unsubscribe) {
    unsubscribe();
    listenerUnsubscribers.delete(telegramId);
  }

  connectionCallbacks.delete(telegramId);

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

  console.log(`[disconnectWallet] Cleanup complete for user ${telegramId}`);
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

  // Convert address to user-friendly format required by TonConnect SDK
  const formattedAddress = toUserFriendlyAddress(params.address);
  console.log(`[sendTransaction] Original address: ${params.address}`);
  console.log(`[sendTransaction] Formatted address: ${formattedAddress}`);

  const transaction = {
    validUntil: Math.floor(Date.now() / 1000) + 600,
    messages: [
      {
        address: formattedAddress,
        amount: params.amount,
        stateInit: params.stateInit,
        payload: params.payload,
      },
    ],
  };

  console.log(`[sendTransaction] Sending transaction for user ${telegramId}`);
  console.log(`[sendTransaction] Amount: ${params.amount}`);
  console.log(`[sendTransaction] Has stateInit: ${!!params.stateInit}`);
  console.log(`[sendTransaction] Has payload: ${!!params.payload}`);

  const result = await connector.sendTransaction(transaction);
  console.log(`[sendTransaction] Transaction sent successfully`);

  return result.boc;
}
