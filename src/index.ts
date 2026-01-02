import 'dotenv/config'; // Must be first!
import { Bot, Context, session, SessionFlavor, InlineKeyboard, InputFile } from 'grammy';
import { toNano, Address } from '@ton/core';
import { initMinter, getMinter } from './minter';
import { calculateMintAmount } from './ton-link';
import {
  generateWalletConnection,
  disconnectWallet,
  isWalletConnected,
  getWalletAddress,
  sendTransaction,
  restoreConnection,
} from './ton-connect';

// Session data
interface SessionData {
  walletAddress?: string;
  walletType?: string;
  qrMessageId?: number;
  pendingMint?: any;
}

type BotContext = Context & SessionFlavor<SessionData>;

// Config
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINTER_ADDRESS = process.env.MINTER_ADDRESS;
const COLLECTION_ADDRESS = process.env.COLLECTION_ADDRESS;
const DEFAULT_METADATA_URL = process.env.DEFAULT_METADATA_URL || 'https://example.com/nft/open4dev.json';
const DEFAULT_METADATA_URL_2 = process.env.DEFAULT_METADATA_URL_2 || 'https://raw.githubusercontent.com/open4dev/open4dev-bot/main/public/nft2.json';
const DEFAULT_PRICE = process.env.DEFAULT_PRICE || '0.01';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is required');
}

if (!MINTER_ADDRESS) {
  throw new Error('MINTER_ADDRESS is required');
}

// Initialize minter service (integrated)
initMinter({
  minterAddress: MINTER_ADDRESS,
  collectionAddress: COLLECTION_ADDRESS,
  defaultPrice: toNano(DEFAULT_PRICE),
});

// Initialize bot
const bot = new Bot<BotContext>(BOT_TOKEN);

// Session middleware
bot.use(session({ initial: (): SessionData => ({}) }));

// Format address for display
function formatAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Convert to bounceable format
function toBounceableAddress(address: string): string {
  try {
    const parsed = Address.parse(address);
    return parsed.toString({ bounceable: true });
  } catch {
    return address;
  }
}

// /start command
bot.command('start', async (ctx) => {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Try to restore connection
  await restoreConnection(telegramId);
  const address = getWalletAddress(telegramId);

  if (address) {
    ctx.session.walletAddress = address;
    await showMainMenu(ctx, address);
  } else {
    await showWelcome(ctx);
  }
});

// Show welcome message
async function showWelcome(ctx: BotContext) {
  const keyboard = new InlineKeyboard()
    .text('Connect Wallet', 'connect_wallet');

  await ctx.reply(
    `Welcome to Open4Dev NFT Minter!\n\n` +
    `Mint exclusive Open4Dev Club NFTs directly from Telegram.\n\n` +
    `Price: ${DEFAULT_PRICE} TON + ~0.08 TON gas\n\n` +
    `Connect your wallet to get started:`,
    { reply_markup: keyboard }
  );
}

// Show main menu (wallet connected)
async function showMainMenu(ctx: BotContext, address: string) {
  const keyboard = new InlineKeyboard()
    .text('🟣 Style 1', 'mint_nft').text('🔵 Style 2', 'mint_nft_2').row()
    .text('Disconnect Wallet', 'disconnect_wallet');

  const bounceableAddress = toBounceableAddress(address);

  const totalPrice = (parseFloat(DEFAULT_PRICE) + 0.08).toFixed(2);

  await ctx.reply(
    `💳 ${formatAddress(bounceableAddress)}\n\n` +
    `Ready to mint your Open4Dev NFT!\n\n` +
    `💎 ~${totalPrice} TON (${DEFAULT_PRICE} + gas)`,
    { reply_markup: keyboard }
  );
}

// /help command
bot.command('help', async (ctx) => {
  await ctx.reply(
    `Open4Dev NFT Minter\n\n` +
    `Commands:\n` +
    `/start - Start bot\n` +
    `/status - Check service status\n` +
    `/help - Show this message\n\n` +
    `How it works:\n` +
    `1. Connect your TON wallet\n` +
    `2. Click "Mint NFT"\n` +
    `3. Confirm transaction in your wallet\n` +
    `4. NFT is minted to your wallet!`
  );
});

// /status command
bot.command('status', async (ctx) => {
  try {
    const minter = getMinter();
    const info = minter.getInfo();
    await ctx.reply(
      `Service Status: Online\n\n` +
      `Minter: ${formatAddress(info.minterAddress)}\n` +
      `Collection: ${info.collectionAddress ? formatAddress(info.collectionAddress) : 'N/A'}\n` +
      `Default Price: ${info.defaultPriceFormatted}`
    );
  } catch (error) {
    await ctx.reply('Service Status: Error\n\nMinter not initialized.');
  }
});

// Connect wallet button
bot.callbackQuery('connect_wallet', async (ctx) => {
  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard()
    .text('Tonkeeper', 'wallet_tonkeeper').row()
    .text('MyTonWallet', 'wallet_mytonwallet').row()
    .text('Telegram Wallet', 'wallet_telegram');

  await ctx.editMessageText('Select your wallet:', { reply_markup: keyboard });
});

// Wallet selection handlers
bot.callbackQuery(/^wallet_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();

  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  if (!telegramId || !chatId) return;

  const walletMap: Record<string, string> = {
    tonkeeper: 'Tonkeeper',
    mytonwallet: 'MyTonWallet',
    telegram: 'Telegram Wallet',
  };

  const walletKey = ctx.match[1];
  const walletType = walletMap[walletKey] || 'Tonkeeper';

  // Delete wallet selection message
  try {
    await ctx.deleteMessage();
  } catch (e) {
    // Ignore
  }

  try {
    let qrMessageId: number | undefined;

    // Callbacks for connection events
    const onConnected = async (address: string) => {
      console.log(`[Bot] Wallet connected: ${address}`);
      ctx.session.walletAddress = address;
      ctx.session.walletType = walletType;

      // Delete QR message
      if (qrMessageId) {
        try {
          await ctx.api.deleteMessage(chatId, qrMessageId);
        } catch (e) {
          // Ignore
        }
      }

      // Show main menu
      await showMainMenu(ctx, address);
    };

    const onDisconnected = async () => {
      console.log(`[Bot] Wallet disconnected`);
      ctx.session.walletAddress = undefined;

      if (qrMessageId) {
        try {
          await ctx.api.editMessageCaption(chatId, qrMessageId, {
            caption: 'Connection cancelled or timed out.',
            reply_markup: new InlineKeyboard().text('Try Again', 'connect_wallet'),
          });
        } catch (e) {
          // Ignore
        }
      }
    };

    // Generate wallet connection
    const { universalLink, qrCodeBuffer } = await generateWalletConnection(
      telegramId,
      walletType,
      onConnected,
      onDisconnected
    );

    // Send QR code
    const keyboard = new InlineKeyboard()
      .url('Open ' + walletType, universalLink).row()
      .text('Cancel', 'cancel_connect');

    const qrMessage = await ctx.replyWithPhoto(
      new InputFile(qrCodeBuffer, 'qr.png'),
      {
        caption: `Connect your ${walletType}\n\nScan QR code or click the button:`,
        reply_markup: keyboard,
      }
    );

    qrMessageId = qrMessage.message_id;
    ctx.session.qrMessageId = qrMessageId;

    // Check if already connected (race condition)
    if (isWalletConnected(telegramId)) {
      const address = getWalletAddress(telegramId);
      if (address) {
        await onConnected(address);
      }
    }
  } catch (error) {
    console.error('[Bot] Wallet connection error:', error);
    await ctx.reply('Failed to generate wallet connection. Please try again.');
  }
});

// Cancel connect
bot.callbackQuery('cancel_connect', async (ctx) => {
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from?.id;
  if (telegramId) {
    await disconnectWallet(telegramId);
  }
  await ctx.deleteMessage();
  await showWelcome(ctx);
});

// Disconnect wallet
bot.callbackQuery('disconnect_wallet', async (ctx) => {
  await ctx.answerCallbackQuery();

  const keyboard = new InlineKeyboard()
    .text('Yes, Disconnect', 'confirm_disconnect').row()
    .text('Cancel', 'cancel_disconnect');

  await ctx.editMessageText('Are you sure you want to disconnect your wallet?', {
    reply_markup: keyboard,
  });
});

bot.callbackQuery('confirm_disconnect', async (ctx) => {
  await ctx.answerCallbackQuery('Wallet disconnected');
  const telegramId = ctx.from?.id;
  if (telegramId) {
    await disconnectWallet(telegramId);
    ctx.session.walletAddress = undefined;
  }
  await ctx.deleteMessage();
  await showWelcome(ctx);
});

bot.callbackQuery('cancel_disconnect', async (ctx) => {
  await ctx.answerCallbackQuery();
  const address = ctx.session.walletAddress;
  if (address) {
    await ctx.deleteMessage();
    await showMainMenu(ctx, address);
  }
});

// Mint NFT helper function
async function handleMint(ctx: BotContext, metadataUrl: string, styleName: string) {
  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  // Restore connection and get address
  await restoreConnection(telegramId);
  const address = getWalletAddress(telegramId);

  if (!address) {
    await ctx.editMessageText('Wallet not connected. Please connect first.', {
      reply_markup: new InlineKeyboard().text('Connect Wallet', 'connect_wallet'),
    });
    return;
  }

  await ctx.editMessageText('Preparing your NFT mint...');

  try {
    // Get signed mint data from integrated minter
    const minter = getMinter();
    const data = minter.signMint(address, metadataUrl, DEFAULT_PRICE);

    const totalAmount = calculateMintAmount(data.price);
    const totalTon = (Number(totalAmount) / 1e9).toFixed(2);

    // Show confirmation
    const keyboard = new InlineKeyboard()
      .text('Confirm Mint', 'confirm_mint').row()
      .text('Cancel', 'back_to_menu');

    // Store mint data in session for confirmation
    ctx.session.pendingMint = data;

    await ctx.editMessageText(
      `Ready to mint Open4Dev NFT (${styleName})!\n\n` +
      `Price: ${data.priceFormatted}\n` +
      `Gas: ~0.08 TON\n` +
      `Total: ~${totalTon} TON\n\n` +
      `Confirm to send transaction:`,
      { reply_markup: keyboard }
    );
  } catch (error: any) {
    console.error('[Bot] Mint preparation error:', error);
    await ctx.editMessageText(`Error: ${error.message || 'Failed to prepare mint'}`, {
      reply_markup: new InlineKeyboard().text('Try Again', 'back_to_menu'),
    });
  }
}

// Mint NFT Style 1
bot.callbackQuery('mint_nft', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleMint(ctx, DEFAULT_METADATA_URL, 'Style 1');
});

// Mint NFT Style 2
bot.callbackQuery('mint_nft_2', async (ctx) => {
  await ctx.answerCallbackQuery();
  await handleMint(ctx, DEFAULT_METADATA_URL_2, 'Style 2');
});

// Confirm mint - send transaction via TonConnect
bot.callbackQuery('confirm_mint', async (ctx) => {
  await ctx.answerCallbackQuery();

  const telegramId = ctx.from?.id;
  if (!telegramId) return;

  const pendingMint = ctx.session.pendingMint;
  if (!pendingMint) {
    await ctx.editMessageText('No pending mint. Please start over.', {
      reply_markup: new InlineKeyboard().text('Mint NFT', 'mint_nft'),
    });
    return;
  }

  await ctx.editMessageText('Sending transaction...\n\nPlease confirm in your wallet.');

  try {
    const totalAmount = calculateMintAmount(pendingMint.price);

    // Send transaction via TonConnect
    const boc = await sendTransaction(telegramId, {
      address: pendingMint.minterItemAddress,
      amount: totalAmount,
      stateInit: pendingMint.stateInit,
      payload: pendingMint.messageBody,
    });

    console.log(`[Bot] Transaction sent: ${boc.slice(0, 20)}...`);

    // Clear pending mint
    ctx.session.pendingMint = undefined;

    await ctx.editMessageText(
      `Transaction sent!\n\n` +
      `Your Open4Dev NFT is being minted.\n\n` +
      `MinterItem:\n\`${pendingMint.minterItemAddress}\`\n\n` +
      `The NFT will appear in your wallet shortly.`,
      { reply_markup: new InlineKeyboard().text('Back to Menu', 'back_to_menu'), parse_mode: 'Markdown' }
    );
  } catch (error: any) {
    console.error('[Bot] Transaction error:', error);

    let errorMessage = 'Transaction failed.';
    const errStr = error?.message || (typeof error === 'string' ? error : JSON.stringify(error));

    if (errStr?.includes('rejected') || errStr?.includes('Rejected')) {
      errorMessage = 'Transaction was rejected in wallet.';
    } else if (errStr?.includes('not connected') || errStr?.includes('NotConnected')) {
      errorMessage = 'Wallet disconnected. Please reconnect.';
    } else if (errStr?.includes('timeout') || errStr?.includes('Timeout')) {
      errorMessage = 'Transaction timed out. Please try again.';
    } else if (errStr) {
      errorMessage = `Error: ${errStr}`;
    }

    await ctx.editMessageText(`${errorMessage}\n\nPlease try again.`, {
      reply_markup: new InlineKeyboard().text('Try Again', 'mint_nft').row().text('Back', 'back_to_menu'),
    });
  }
});

// Back to menu
bot.callbackQuery('back_to_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const address = ctx.session.walletAddress || getWalletAddress(ctx.from?.id || 0);

  // Clear pending mint
  ctx.session.pendingMint = undefined;

  await ctx.deleteMessage();
  if (address) {
    await showMainMenu(ctx, address);
  } else {
    await showWelcome(ctx);
  }
});

// Error handler
bot.catch((err) => {
  console.error('Bot error:', err);
});

// Start bot
async function main() {
  console.log('Starting Open4Dev NFT Minter Bot...');
  const minter = getMinter();
  const info = minter.getInfo();
  console.log(`Minter Address: ${info.minterAddress}`);
  console.log(`Default Price: ${info.defaultPriceFormatted}`);
  await bot.start();
}

main();
