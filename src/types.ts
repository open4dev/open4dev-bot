export interface MintSignResponse {
  success: boolean;
  data: {
    minterItemAddress: string;
    stateInit: string;
    messageBody: string;
    signature: string;
    price: string;
    priceFormatted: string;
    metadataUrl: string;
    ownerAddress: string;
    dataHash: string;
  };
  error?: string;
}

export interface ServiceInfoResponse {
  success: boolean;
  data: {
    minterAddress: string;
    collectionAddress: string;
    servicePublicKey: string;
    defaultPrice: string;
    defaultPriceFormatted: string;
  };
}

export interface UserSession {
  walletAddress?: string;
  pendingMint?: MintSignResponse['data'];
}
