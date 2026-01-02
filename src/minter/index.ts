import nacl from 'tweetnacl';
import fs from 'fs';
import path from 'path';
import { Cell, beginCell, Address, contractAddress, toNano } from '@ton/core';

// MinterItem compiled code (from nft-minter-tolk/build/MinterItem.compiled.json)
const MINTER_ITEM_CODE_HEX = 'b5ee9c724101040100ee000114ff00f4a413f4bcf2c80b0102f8d3f8918e5cd31f31d72c20282ee18c318e4ced44d0d20031fa00fa48fa48d3fff404d1c8cf815005fa0213fa525210fa5212cbff12f400c9ed54f8276f108209312d00a120c2008e12c8cf850812fa5201fa0270cf0b6ac972fb00915be2e0f23fe0ed44d0d20020fa00fa48fa48d3fff40507d72c248118f164e302020300b606f2d0ccf89222c705f2e0caf8276f1024bef2e0cb266ef2d0d126c8cc24fa025220fa52f91606d33f8308d7194707f910f2e0cdc8cf858812fa5282100505dc31cf0b8e14cb3f01fa0212fa5212ccc98040fb00c8cf83cec9ed540004f23f81078c88';

// ============= KEYS =============

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

const KEYS_FILE = path.join(process.cwd(), '.keys.json');

export function generateKeyPair(): KeyPair {
  return nacl.sign.keyPair();
}

export function publicKeyToBigInt(publicKey: Uint8Array): bigint {
  const hex = Buffer.from(publicKey).toString('hex');
  return BigInt('0x' + hex);
}

export function saveKeyPair(keys: KeyPair, filepath: string = KEYS_FILE): void {
  const data = {
    publicKey: Buffer.from(keys.publicKey).toString('hex'),
    secretKey: Buffer.from(keys.secretKey).toString('hex'),
  };
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  console.log(`[Minter] Keys saved to ${filepath}`);
}

export function loadKeyPair(filepath: string = KEYS_FILE): KeyPair | null {
  if (!fs.existsSync(filepath)) {
    return null;
  }
  const data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  return {
    publicKey: new Uint8Array(Buffer.from(data.publicKey, 'hex')),
    secretKey: new Uint8Array(Buffer.from(data.secretKey, 'hex')),
  };
}

export function getOrCreateKeyPair(filepath: string = KEYS_FILE): KeyPair {
  let keys = loadKeyPair(filepath);
  if (!keys) {
    console.log('[Minter] No existing keys found, generating new keypair...');
    keys = generateKeyPair();
    saveKeyPair(keys, filepath);
  }
  return keys;
}

// ============= SIGNING =============

export interface SignedNFTData {
  content: Cell;
  price: bigint;
  ownerAddress: Address;
  dataHash: Buffer;
  signature: bigint;
}

export function createNftContent(metadataUrl: string): Cell {
  return beginCell()
    .storeUint(0x01, 8)
    .storeStringTail(metadataUrl)
    .endCell();
}

export function hashMintData(content: Cell, price: bigint, ownerAddress: Address): Buffer {
  const cell = beginCell()
    .storeRef(content)
    .storeCoins(price)
    .storeAddress(ownerAddress)
    .endCell();
  return cell.hash();
}

export function signMintData(
  content: Cell,
  price: bigint,
  ownerAddress: Address,
  secretKey: Uint8Array
): SignedNFTData {
  const dataHash = hashMintData(content, price, ownerAddress);
  const signatureBytes = nacl.sign.detached(dataHash, secretKey);
  const signatureHex = Buffer.from(signatureBytes).toString('hex');
  const signature = BigInt('0x' + signatureHex);

  return {
    content,
    price,
    ownerAddress,
    dataHash,
    signature,
  };
}

// ============= CONTRACTS =============

function getMinterItemCode(): Cell {
  return Cell.fromBoc(Buffer.from(MINTER_ITEM_CODE_HEX, 'hex'))[0];
}

function packMinterItemData(
  ownerAddress: Address,
  minterAddress: Address,
  publicKey: bigint,
  price: bigint,
  content: Cell
): Cell {
  return beginCell()
    .storeBit(false) // isMinted = false
    .storeCoins(price)
    .storeAddress(minterAddress)
    .storeAddress(ownerAddress)
    .storeUint(publicKey, 256)
    .storeMaybeRef(content)
    .endCell();
}

function calculateMinterItemStateInit(
  ownerAddress: Address,
  minterAddress: Address,
  publicKey: bigint,
  price: bigint,
  content: Cell
): { code: Cell; data: Cell } {
  const data = packMinterItemData(ownerAddress, minterAddress, publicKey, price, content);
  return { code: getMinterItemCode(), data };
}

function createMintMessageBody(signature: bigint, queryId: bigint = 0n): Cell {
  return beginCell()
    .storeUint(0x90231e2c, 32) // opMintItem
    .storeUint(queryId, 64)
    .storeUint(signature, 512)
    .endCell();
}

// ============= MINT DATA =============

export interface MintData {
  minterItemAddress: string;
  stateInit: string;
  messageBody: string;
  signature: string;
  price: string;
  priceFormatted: string;
  metadataUrl: string;
  ownerAddress: string;
  dataHash: string;
}

export function prepareMintData(
  ownerAddress: Address,
  minterAddress: Address,
  publicKey: bigint,
  price: bigint,
  content: Cell,
  signature: bigint
): MintData {
  const init = calculateMinterItemStateInit(
    ownerAddress,
    minterAddress,
    publicKey,
    price,
    content
  );

  const address = contractAddress(0, init);
  const messageBody = createMintMessageBody(signature);

  // Create state init cell
  const stateInitCell = beginCell()
    .storeUint(0, 2)
    .storeMaybeRef(init.code)
    .storeMaybeRef(init.data)
    .storeUint(0, 1)
    .endCell();

  const priceInTon = Number(price) / 1e9;

  return {
    minterItemAddress: address.toString(),
    stateInit: stateInitCell.toBoc().toString('base64'),
    messageBody: messageBody.toBoc().toString('base64'),
    signature: signature.toString(16),
    price: price.toString(),
    priceFormatted: priceInTon.toFixed(2) + ' TON',
    metadataUrl: '',
    ownerAddress: ownerAddress.toString(),
    dataHash: '',
  };
}

// ============= MINTER SERVICE =============

export interface MinterConfig {
  minterAddress: string;
  collectionAddress?: string;
  defaultPrice: bigint;
  keysPath?: string;
}

export class MinterService {
  private keys: KeyPair;
  private config: MinterConfig;

  constructor(config: MinterConfig) {
    this.config = config;
    this.keys = getOrCreateKeyPair(config.keysPath);
    console.log('[Minter] Service initialized');
    console.log('[Minter] Public Key:', Buffer.from(this.keys.publicKey).toString('hex'));
    console.log('[Minter] Minter Address:', config.minterAddress);
    console.log('[Minter] Default Price:', Number(config.defaultPrice) / 1e9, 'TON');
  }

  getPublicKey(): string {
    return Buffer.from(this.keys.publicKey).toString('hex');
  }

  getPublicKeyBigInt(): bigint {
    return publicKeyToBigInt(this.keys.publicKey);
  }

  getInfo() {
    return {
      publicKey: this.getPublicKey(),
      publicKeyBigInt: this.getPublicKeyBigInt().toString(),
      minterAddress: this.config.minterAddress,
      collectionAddress: this.config.collectionAddress,
      defaultPrice: this.config.defaultPrice.toString(),
      defaultPriceFormatted: (Number(this.config.defaultPrice) / 1e9).toFixed(2) + ' TON',
    };
  }

  signMint(ownerAddress: string, metadataUrl: string, price?: string): MintData {
    const owner = Address.parse(ownerAddress);
    const minter = Address.parse(this.config.minterAddress);
    const publicKey = this.getPublicKeyBigInt();

    // Parse price
    let priceValue = this.config.defaultPrice;
    if (price) {
      const num = parseFloat(price);
      priceValue = num < 1000 ? toNano(price) : BigInt(price);
    }

    // Create content and sign
    const content = createNftContent(metadataUrl);
    const signedData = signMintData(content, priceValue, owner, this.keys.secretKey);

    // Prepare mint data
    const mintData = prepareMintData(
      owner,
      minter,
      publicKey,
      priceValue,
      content,
      signedData.signature
    );

    return {
      ...mintData,
      metadataUrl,
      ownerAddress: owner.toString(),
      dataHash: signedData.dataHash.toString('hex'),
    };
  }
}

// ============= SINGLETON INSTANCE =============

let minterInstance: MinterService | null = null;

export function initMinter(config: MinterConfig): MinterService {
  minterInstance = new MinterService(config);
  return minterInstance;
}

export function getMinter(): MinterService {
  if (!minterInstance) {
    throw new Error('Minter not initialized. Call initMinter() first.');
  }
  return minterInstance;
}
