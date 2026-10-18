/**
 * GET /v1/config/assets — Asset configuration endpoint.
 *
 * Public callers receive only the information strictly needed to set up a
 * trustline against the ACBU asset: the asset code/issuer and the Stellar
 * network passphrase.  Infrastructure details (Horizon URL, Soroban RPC URL,
 * contract addresses) are gated behind API-key authentication to limit the
 * information-disclosure surface described in W10-BE-013.
 *
 * Authenticated callers (valid `x-api-key` or `Authorization: Bearer <key>`)
 * receive the full response including infra endpoints.
 */
import { Response, NextFunction } from "express";
import { stellarClient } from "../services/stellar/client";
import { getContractAddresses } from "../config/contracts";
import { AuthRequest } from "../middleware/auth";

/**
 * Returns only the public-safe subset of asset config.
 * Used when the caller is unauthenticated.
 */
function buildPublicPayload(code: string, issuer: string | undefined) {
  return {
    acbu: {
      code,
      issuer: issuer ?? null,
    },
    demo_fiat: {
      issuer: issuer ?? null,
    },
    stellar: {
      network_passphrase: stellarClient.getNetworkPassphrase(),
    },
  };
}

/**
 * Returns the full asset config including infra-endpoint details.
 * Used only when the caller has presented a valid API key.
 */
function buildAuthenticatedPayload(code: string, issuer: string | undefined) {
  return {
    acbu: {
      code,
      issuer: issuer ?? null,
    },
    demo_fiat: {
      issuer: issuer ?? null,
    },
    stellar: {
      network_passphrase: stellarClient.getNetworkPassphrase(),
      horizon_url: stellarClient.getHorizonUrl?.() ?? null,
      soroban_rpc_url: stellarClient.getSorobanRpcUrl?.() ?? null,
    },
    contracts: {
      burning: getContractAddresses().burning || null,
    },
  };
}

export async function getPublicAssetsConfig(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const issuer = process.env.STELLAR_ACBU_ASSET_ISSUER;
    const code = (process.env.STELLAR_ACBU_ASSET_CODE || "ACBU")
      .trim()
      .toUpperCase();

    // If the request carries a valid API key (set by optional auth middleware
    // upstream, or detectable here), return the full infra payload.
    // Otherwise return only the public-safe subset.
    const isAuthenticated = !!(req as AuthRequest).apiKey;

    const payload = isAuthenticated
      ? buildAuthenticatedPayload(code, issuer)
      : buildPublicPayload(code, issuer);

    res.status(200).json(payload);
  } catch (e) {
    next(e);
  }
}
