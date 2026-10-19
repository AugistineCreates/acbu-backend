/**
 * Transfer service: resolve alias to stellarAddress, create Transaction, optionally submit Stellar payment.
 * Uses direct wallets (G...). When getSenderSigningKey is provided, signs and submits; otherwise leaves pending.
 */
import { Operation, Asset, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";
import { prisma } from "../../config/database";
import { stellarClient } from "../stellar/client";
import { getBaseFee, getPaymentFee } from "../stellar/feeManager";
import type { PaymentFeeQuote } from "../stellar/feeManager";
import { normalizeRecipientQuery, resolveRecipient } from "../recipient/recipientResolver";
import { getAcbuAsset } from "../../config/acbuAsset";
import { StellarFeeSurgeError } from "../../errors";
import crypto from "crypto";
import { reserveWalletVersion, fetchWalletBalance } from "../wallet/walletStateService";

import { logger, logFinancialEvent } from "../../config/logger";
import type { CreateTransferParams, CreateTransferOptions, CreateTransferResult } from "./types";

/**
 * W10-BE-008: money-moving transfers must carry an idempotency key so a client
 * timeout/retry cannot create a duplicate transaction row or a duplicate Stellar
 * payment. Enforced here (server-side) in addition to the controller check so
 * no caller can bypass it.
 */
function requireIdempotencyKey(idempotencyKey: string | undefined | null): string {
  if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0) {
    throw new Error("Idempotency key is required for transfers");
  }
  return idempotencyKey.trim();
}

/** Parse a non-negative amount string into 7-decimal smallest units to avoid float drift. */
function amountToSmallestUnit(amount: string): number {
  const [wholePart, fracPart = ""] = amount.split(".");
  return parseInt(wholePart, 10) * 10000000 + parseInt(fracPart.slice(0, 7).padEnd(7, "0"), 10);
}

/**
 * Resolve an alias (@user, E.164, email) or raw G... to a Stellar address.
 * Raw addresses pass through shape-validated by normalizeRecipientQuery; aliases
 * go through resolveRecipient + user lookup. Returns null when unresolvable.
 */
async function resolveRecipientAddress(to: string, callerUserId: string): Promise<string | null> {
  const parsed = normalizeRecipientQuery(to);
  if (parsed.kind === "address") {
    return parsed.value;
  }
  const recipient = await resolveRecipient(to, callerUserId);
  if (!recipient) {
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: recipient.userId },
    select: { stellarAddress: true },
  });
  return user?.stellarAddress ?? null;
}

/**
 * AB-052: build + submit attempts allowed for a single payment before an
 * underpriced transaction is surfaced to the caller as a StellarFeeSurgeError.
 * Each retry is safe: nothing has been submitted yet, so no sequence number is
 * consumed and no funds have moved.
 */
const MAX_SUBMIT_ATTEMPTS = 3;

/**
 * How long a built payment transaction stays valid on-chain, in seconds.
 *
 * Required: `@stellar/stellar-base` v15 refuses to `build()` a transaction
 * without TimeBounds ("TimeBounds has to be set or you must call
 * setTimeout(TimeoutInfinite)"). A bounded window is preferred over
 * `TimeoutInfinite` because it caps how long a repriced transaction can linger
 * and still be included — relevant here, where a transaction may be rebuilt
 * several times while the network fee is moving.
 */
const PAYMENT_VALIDITY_SECONDS = 60;

/**
 * Horizon/Stellar result codes that unambiguously mean "the fee on this
 * transaction was below the network's base fee".
 *
 * `tx_fee_bump_inner_failed` is deliberately *not* here: it is the wrapper's
 * code for *any* failed inner transaction, so treating it as a fee rejection
 * would misattribute a bad signature, insufficient balance, or missing source
 * account as a fee surge and burn the retry budget rediscovering it. It is
 * handled separately in {@link isInsufficientFeeRejection}, which only accepts
 * it once the inner result codes also indicate underpricing.
 */
const INSUFFICIENT_FEE_RESULT_CODES = new Set(["tx_insufficient_fee"]);

/** Outer code used when the inner transaction of a fee-bump wrapper fails. */
const FEE_BUMP_INNER_FAILED = "tx_fee_bump_inner_failed";

/** Audit fields attached to fee-related log lines so a surge can be traced back to a transfer. */
export interface SubmitStellarPaymentLogContext {
  transactionId?: string;
  correlationId?: string;
}

/** The subset of Horizon's `extras` payload that carries transaction result codes. */
interface HorizonResultCodes {
  transaction?: string;
  operations?: string[];
  transactions?: string[];
}

type HorizonExtras = {
  result_codes?: HorizonResultCodes;
  result_codes_transactions?: string[];
};

/**
 * Detect a Horizon rejection caused by an underpriced transaction.
 *
 * Horizon reports the reason in `response.data.extras.result_codes`, but that
 * shape is absent when the request never reached Horizon (timeouts, 5xx) and the
 * code can also arrive as a bare error message, so both are inspected.
 */
function isInsufficientFeeRejection(error: unknown): boolean {
  const candidate = error as
    | {
        message?: unknown;
        response?: {
          data?: {
            extras?: HorizonExtras;
          };
        };
      }
    | null
    | undefined;

  const extras = candidate?.response?.data?.extras;
  const resultCodes = extras?.result_codes;
  const message = typeof candidate?.message === "string" ? candidate.message : null;

  if (message?.includes("tx_insufficient_fee")) {
    return true;
  }

  if (resultCodes?.transaction && INSUFFICIENT_FEE_RESULT_CODES.has(resultCodes.transaction)) {
    return true;
  }
  if (
    Array.isArray(resultCodes?.operations) &&
    resultCodes.operations.some((code) => INSUFFICIENT_FEE_RESULT_CODES.has(code))
  ) {
    return true;
  }

  // A failed fee-bump wrapper only counts as a fee problem when the inner
  // transaction's own codes say it was underpriced.
  if (resultCodes?.transaction === FEE_BUMP_INNER_FAILED) {
    const innerCodes = [
      ...(extras?.result_codes_transactions ?? []),
      ...(resultCodes?.transactions ?? []),
    ];
    return innerCodes.some((code) => INSUFFICIENT_FEE_RESULT_CODES.has(code));
  }

  return typeof message === "string" ? INSUFFICIENT_FEE_RESULT_CODES.has(message.trim()) : false;
}

/** Outcome of re-reading the network base fee immediately before submission. */
interface FeeRevalidation {
  /** True when the fee already on the built transaction is still high enough. */
  current: boolean;
  /** The freshly read network base fee, or null when it could not be read. */
  networkFeeStroops: number | null;
}

/**
 * Re-read the network base fee and check it against the fee on a built
 * transaction, immediately before that transaction is submitted.
 *
 * Building and submitting a transaction are separated by a network round trip,
 * during which the base fee can rise — which is what turns a correctly priced
 * transfer into a `tx_insufficient_fee` rejection under load. Comparing against
 * a freshly read fee converts that certain on-chain rejection into a cheap
 * local rebuild. When the read fails the transaction is submitted as priced: an
 * unavailable check must never block an otherwise valid payment.
 */
async function revalidateFeeBeforeSubmit(builtQuote: PaymentFeeQuote): Promise<FeeRevalidation> {
  let networkFeeStroops: number;
  try {
    networkFeeStroops = Number.parseInt(await getBaseFee(), 10);
  } catch (err) {
    logger.warn("Could not re-validate Stellar fee before submission; submitting as priced", {
      feeStroops: builtQuote.feeStroops,
      err,
    });
    return { current: true, networkFeeStroops: null };
  }

  if (!Number.isFinite(networkFeeStroops)) {
    logger.warn("Stellar fee re-validation returned a non-numeric fee; submitting as priced", {
      feeStroops: builtQuote.feeStroops,
      networkFeeStroops,
    });
    return { current: true, networkFeeStroops: null };
  }

  return {
    current: builtQuote.feeStroops >= networkFeeStroops,
    networkFeeStroops,
  };
}

/**
 * Build, sign with sender key, and submit a Stellar payment. Returns hash or throws.
 *
 * The fee is not resolved once per call. It is re-read on every attempt and
 * re-validated immediately before submission, so a base-fee increase that lands
 * after the transaction is built is absorbed by rebuilding rather than by losing
 * the payment to `tx_insufficient_fee` (AB-052)
 */
export async function createTransfer(
  params: CreateTransferParams,
  options: CreateTransferOptions = {}
): Promise<CreateTransferResult> {
  // W10-BE-008: reject money-moving transfers that lack an idempotency key
  // before any transaction row is created or any Stellar payment is submitted.
  const idempotencyKey = requireIdempotencyKey(params.idempotencyKey);

  const { fromUserId, to, amount, currency = "ACBU", memo } = params;
  const { getSenderSigningKey, correlationId } = options;

  const sender = await prisma.user.findUnique({
    where: { id: fromUserId },
    select: { id: true, stellarAddress: true },
  });
  if (!sender?.stellarAddress) {
    throw new Error("Sender has no Stellar address");
  }

  const recipientAddress = await resolveRecipientAddress(to, fromUserId);
  if (!recipientAddress) {
    throw new Error("Recipient could not be resolved");
  }

  const amountSmallest = amountToSmallestUnit(amount);
  if (!Number.isFinite(amountSmallest) || amountSmallest <= 0) {
    throw new Error("Invalid transfer amount");
  }

  const existing = await prisma.transaction.findUnique({
    where: { idempotencyKey },
    select: { id: true, status: true, stellarTxHash: true },
  });
  if (existing) {
    return {
      transactionId: existing.id,
      status: existing.status,
      stellarTxHash: existing.stellarTxHash ?? undefined,
    };
  }

  const transaction = await prisma.transaction.create({
    data: {
      userId: fromUserId,
      type: "transfer",
      amount: new Prisma.Decimal(amount),
      currency,
      status: "pending",
      idempotencyKey,
      metadata: {
        to,
        recipientAddress,
        memo: memo ?? null,
        correlationId: correlationId ?? null,
      },
    },
  });

  if (!getSenderSigningKey) {
    return { transactionId: transaction.id, status: "pending" };
  }

  const signingKey = await getSenderSigningKey();
  const senderKeypair = Keypair.fromSecret(signingKey);
  const acbuAsset = getAcbuAsset();

  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_SUBMIT_ATTEMPTS; attempt++) {
    const quote = await getPaymentFee();
    const account = await stellarClient.loadAccount(sender.stellarAddress);
    const tx = new TransactionBuilder(account, {
      fee: String(quote.feeStroops),
      networkPassphrase: stellarClient.getNetworkPassphrase(),
    })
      .addOperation(
        Operation.payment({
          destination: recipientAddress,
          asset: acbuAsset,
          amount,
        })
      )
      .setTimeout(PAYMENT_VALIDITY_SECONDS)
      .build();

    tx.sign(senderKeypair);

    const revalidation = await revalidateFeeBeforeSubmit(quote);
    if (!revalidation.current) {
      logger.warn("Stellar base fee rose before submission; rebuilding transaction", {
        transactionId: transaction.id,
        correlationId,
        builtFeeStroops: quote.feeStroops,
        networkFeeStroops: revalidation.networkFeeStroops,
      });
      continue;
    }

    try {
      const result = await stellarClient.submitTransaction(tx);
      await prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: "completed", stellarTxHash: result.hash },
      });
      logFinancialEvent("transfer.completed", {
        transactionId: transaction.id,
        correlationId,
        stellarTxHash: result.hash,
      });
      return {
        transactionId: transaction.id,
        status: "completed",
        stellarTxHash: result.hash,
      };
    } catch (err) {
      lastError = err;
      if (!isInsufficientFeeRejection(err)) {
        throw err;
      }
      logger.warn("Stellar rejected underpriced payment; retrying with fresh fee", {
        transactionId: transaction.id,
        correlationId,
        attempt,
      });
    }
  }

  throw new StellarFeeSurgeError(
    "Stellar network fee surged; transfer could not be submitted",
    { transactionId: transaction.id, correlationId, cause: lastError }
  );
}
