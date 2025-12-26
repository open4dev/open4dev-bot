import fetch from 'node-fetch';
import { MintSignResponse, ServiceInfoResponse } from './types';

export class MinterService {
  constructor(private baseUrl: string) {}

  async getInfo(): Promise<ServiceInfoResponse> {
    const response = await fetch(`${this.baseUrl}/info`);
    return response.json() as Promise<ServiceInfoResponse>;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      const data = await response.json() as { status: string };
      return data.status === 'ok';
    } catch {
      return false;
    }
  }

  async signMint(
    ownerAddress: string,
    metadataUrl: string,
    price?: string
  ): Promise<MintSignResponse> {
    const response = await fetch(`${this.baseUrl}/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAddress,
        metadataUrl,
        price,
      }),
    });
    return response.json() as Promise<MintSignResponse>;
  }

  async verifyDeployment(address: string): Promise<boolean> {
    const response = await fetch(`${this.baseUrl}/verify-deployment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    const data = await response.json() as { deployed: boolean };
    return data.deployed;
  }
}
