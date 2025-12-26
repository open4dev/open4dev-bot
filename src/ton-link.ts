// Generate TON transaction deep links for various wallets

export interface TransactionParams {
  address: string;      // Destination address
  amount: string;       // Amount in nanoTON
  stateInit?: string;   // Base64 state init
  payload?: string;     // Base64 message body
}

// Universal TON link (works with most wallets)
export function generateTonLink(params: TransactionParams): string {
  const { address, amount, stateInit, payload } = params;

  let url = `ton://transfer/${address}?amount=${amount}`;

  if (stateInit) {
    url += `&stateInit=${encodeURIComponent(stateInit)}`;
  }

  if (payload) {
    url += `&bin=${encodeURIComponent(payload)}`;
  }

  return url;
}

// Tonkeeper specific link
export function generateTonkeeperLink(params: TransactionParams): string {
  const { address, amount, stateInit, payload } = params;

  let url = `https://app.tonkeeper.com/transfer/${address}?amount=${amount}`;

  if (stateInit) {
    url += `&stateInit=${encodeURIComponent(stateInit)}`;
  }

  if (payload) {
    url += `&bin=${encodeURIComponent(payload)}`;
  }

  return url;
}

// Calculate total amount: price + gas buffer (0.08 TON for gas)
export function calculateMintAmount(priceNano: string): string {
  const price = BigInt(priceNano);
  const gasBuffer = BigInt(80_000_000); // 0.08 TON
  return (price + gasBuffer).toString();
}
