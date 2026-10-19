# ACBU API Reference

This document is the canonical specification for the ACBU platform API. It covers the oracle price-feed architecture, fee policy, and worked integration examples.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Authentication](#2-authentication)
3. [Rate Limits](#3-rate-limits)
4. [Error Codes](#4-error-codes)
5. [Currencies and Basket](#5-currencies-and-basket)
6. [Oracle Architecture](#6-oracle-architecture)
7. [Price Aggregation](#7-price-aggregation)
8. [Mint (Deposit)](#8-mint-deposit)
9. [Burn (Redemption)](#9-burn-redemption)
10. [Transfers](#10-transfers)
11. [Treasury](#11-treasury)
12. [Fee Policy](#12-fee-policy)
13. [Health Checks](#13-health-checks)
14. [Recovery Flow](#14-recovery-flow)
15. [Webhooks](#15-webhooks)
16. [Changelog](#16-changelog)
17. [Worked Examples](#17-worked-examples)

---

## 1. Overview

ACBU (African Currency Basket Unit) is a stablecoin backed by a basket of African currencies. The platform provides mint, burn, and transfer operations on the Stellar blockchain. Reserves are tracked across multiple fintech partners and reconciled against on-chain supply.

---

## 2. Authentication

All API requests require an API key passed in the `Authorization` header:

```
Authorization: Bearer <api_key>
```

API keys are scoped to segments (retail, SME, enterprise, etc.) and must match the route's required scope.

---

## 3. Rate Limits

| Tier       | Requests/minute |
|------------|-----------------|
| Retail     | 60              |
| SME        | 300             |
| Enterprise | 1 200           |

Rate limit headers returned on every response:
- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset`

---

## 4. Error Codes

| Code                        | HTTP Status | Description                                      |
|-----------------------------|-------------|--------------------------------------------------|
| `VALIDATION_ERROR`          | 400         | Request body or params failed schema validation  |
| `UNAUTHORIZED`              | 401         | Missing or invalid API key                       |
| `FORBIDDEN`                 | 403         | API key lacks required scope                     |
| `NOT_FOUND`                 | 404         | Resource not found                               |
| `CIRCUIT_BREAKER`           | 503         | Minting or withdrawal paused (reserve threshold) |
| `DEPOSIT_ONLY_BASKET_CURRENCIES` | 400    | Non-basket currency deposit attempted            |
| `INVALID_CURRENCY`          | 400         | Unsupported currency code                        |
| `INTERNAL_SERVER_ERROR`     | 500         | Unexpected server fault                          |

---

## 5. Currencies and Basket

The ACBU basket currently includes the following currencies and approximate target weights:

| Currency | Code | Approx. Target Weight |
|----------|------|-----------------------|
| Nigerian Naira      | NGN | 25% |
| Kenyan Shilling     | KES | 20% |
| South African Rand  | ZAR | 15% |
| Ghanaian Cedi       | GHS | 10% |
| Egyptian Pound      | EGP | 10% |
| Rwandan Franc       | RWF |  8% |
| Moroccan Dirham     | MAD |  7% |
| Tanzanian Shilling  | TZS |  3% |
| Ugandan Shilling    | UGX |  2% |

> Weights are updated quarterly by the DAO governance process and may differ from the values above. Always fetch current weights from `GET /v1/basket`.

---

## 6. Oracle Architecture

The ACBU oracle fetches exchange rates from four independent data sources for each basket currency:

| Layer | Source | Description |
|-------|--------|-------------|
| Central Bank | `centralBankClient` | Official central bank published rates |
| Fintech | `fintechRouter` | Live market rates from fintech partners |
| Forex | `forexClient` | International FX market rates |
| World Bank | `worldBankClient` | World Bank development data rates |

Each layer is fetched independently. If a layer is unavailable, it is excluded and the remaining layer weights are renormalized to sum to 100% before aggregation.

Outlier detection runs before final aggregation: any source whose rate deviates from the median by more than **3%** is removed from the composite calculation.

A circuit breaker guards against sudden rate shifts: if the new composite rate deviates from the previous stored rate by more than **10%**, the system falls back to the 48-hour TWAP rather than accepting the outlier composite.

---

## 7. Price Aggregation

### 7.1 Layer Definitions

The oracle aggregates rates from four data layers:

| Layer       | Weight |
|-------------|--------|
| Central Bank | 25%   |
| Fintech      | 25%   |
| Forex        | 25%   |
| World Bank   | 25%   |

### 7.2 Aggregation Method

The composite rate is computed as a **weighted average** of the available layer rates, re-normalised for any missing or excluded layers.

Let $r_i$ be the rate from layer $i$ and $w_i$ be its assigned weight. The composite is:

$$r_{\text{composite}} = \frac{\sum_{i \in \text{available}} w_i \cdot r_i}{\sum_{i \in \text{available}} w_i}$$

This is a weighted arithmetic mean, not a median. A median is a rank-order statistic that ignores numeric weights; the weights 25/25/25/25 are only meaningful under a weighted average.

**Example** — all four layers available for NGN:

| Layer        | Weight | Rate (NGN/USD) |
|--------------|--------|----------------|
| Central Bank | 0.25   | 1 600.00       |
| Fintech      | 0.25   | 1 595.00       |
| Forex        | 0.25   | 1 605.00       |
| World Bank   | 0.25   | 1 602.00       |

$$r = \frac{0.25 \times 1600 + 0.25 \times 1595 + 0.25 \times 1605 + 0.25 \times 1602}{1.00} = \frac{6402}{4} = 1600.50 \text{ NGN/USD}$$

**Example** — World Bank layer unavailable; remaining three renormalized (each gets weight 1/3):

$$r = \frac{1600 + 1595 + 1605}{3} = 1600.00 \text{ NGN/USD}$$

### 7.3 ACBU/USD Rate

The ACBU/USD rate is computed as a synthetic basket: 1 ACBU represents 1 USD of notional value split across basket currencies by their target weights. For each currency leg $c$:

$$q_c = \frac{w_c}{W \cdot r_c}$$

where $w_c$ is the target weight, $W$ is the sum of all target weights, and $r_c$ is the composite USD rate for currency $c$.

The overall ACBU/USD rate is the sum of all leg notionals.

---

## 8. Mint (Deposit)

### `POST /v1/mint/deposit`

Deposit a basket currency to mint ACBU tokens.

**Request**

```json
{
  "currency": "NGN",
  "amount": "500000",
  "wallet_address": "G...",
  "fintech_tx_id": "FLW-12345"
}
```

**Response `202 Accepted`**

```json
{
  "transaction_id": "uuid",
  "currency": "NGN",
  "amount": "500000",
  "status": "pending",
  "message": "Deposit received. Complete payment to the designated account for your currency; ACBU will be minted after confirmation."
}
```

The ACBU minted is credited to `wallet_address` on the Stellar network after the fiat payment is confirmed.

---

## 9. Burn (Redemption)

### `POST /v1/burn/acbu`

Burn ACBU tokens to redeem a basket currency.

**Request**

```json
{
  "acbu_amount": "500",
  "currency": "GHS",
  "recipient_account": {
    "type": "mobile_money",
    "account_number": "0201234567",
    "bank_code": "MTN",
    "account_name": "Kwame Mensah"
  }
}
```

**Response `200 OK`**

```json
{
  "transaction_id": "uuid",
  "acbu_amount": "500",
  "local_amount": null,
  "currency": "GHS",
  "fee": "0.50",
  "status": "pending",
  "estimated_completion": null
}
```

---

## 10. Transfers

### `POST /v1/transfers`

Transfer ACBU between wallets.

**Request**

```json
{
  "from_wallet": "G...",
  "to_wallet": "G...",
  "amount": "100",
  "memo": "invoice-2026-001"
}
```

**Response `202 Accepted`**

```json
{
  "transaction_id": "uuid",
  "status": "pending",
  "blockchain_tx_hash": null
}
```

---

## 11. Treasury

### `GET /v1/enterprise/treasury`

Returns verified reserve balances with reconciliation status.

**Query Parameters**

| Parameter   | Type  | Default | Description                              |
|-------------|-------|---------|------------------------------------------|
| `tolerance` | float | `0.01`  | Reconciliation tolerance in percent (0–100) |

See [treasury.md](treasury.md) for full response schema.

---

## 12. Fee Policy

All fees are expressed in basis points (BPS). 1 BPS = 0.01%.

### Mint Fees

| Reserve Ratio | Fee (BPS) | Fee (%) |
|---------------|-----------|---------|
| ≥ 1.02        | 30        | 0.30%   |
| < 1.02        | 50        | 0.50%   |
| Maximum cap   | 100       | 1.00%   |

The mint fee is applied to the **local currency amount** before conversion to ACBU.

### Burn Fees

| Reserve Weight (% of Target) | Fee (BPS) | Fee (%) |
|------------------------------|-----------|---------|
| < 85%                        | 200       | 2.00%   |
| 85% – 115%                   | 10        | 0.10%   |
| > 115%                       | 5         | 0.05%   |

The burn fee is applied to the **ACBU amount** before conversion to local currency.

See [fees.md](fees.md) for full fee policy documentation.

---

## 13. Health Checks

| Endpoint                  | Purpose                              |
|---------------------------|--------------------------------------|
| `GET /api/v1/health`      | Shallow liveness (always 200)        |
| `GET /api/v1/health/ready`| Readiness probe (checks dependencies)|
| `GET /api/v1/health/deep` | Deep dependency status for monitoring|

---

## 14. Recovery Flow

Two-step account recovery:

1. `POST /v1/recovery/unlock` — Submit identifier + passcode; receive `challenge_token` and OTP via email or SMS.
2. `POST /v1/recovery/verify-otp` — Submit `challenge_token` + OTP code; receive new API key.

The OTP is strictly bound to the `challenge_token` issued in step 1. Presenting a different `challenge_token` from a concurrent session will not satisfy the OTP verification, even if that session's OTP has not yet expired.

---

## 15. Webhooks

Webhooks are sent for the following events:

| Event                        | Description                          |
|------------------------------|--------------------------------------|
| `transaction.mint.completed` | ACBU minted and credited to wallet   |
| `transaction.burn.completed` | Local currency disbursed             |
| `transaction.failed`         | Transaction failed (any type)        |

Payload includes `event`, `transaction_id`, `timestamp`, and event-specific fields.

---

## 16. Changelog

| Version | Date       | Changes                                              |
|---------|------------|------------------------------------------------------|
| 3.0     | 2026-10-19 | Fixed aggregation description: weighted average (not weighted median); corrected §17.3 worked examples; recovery OTP now strictly bound to challenge_token (W10-DOC-015, W10-DOC-005, W10-BE-020) |
| 2.0     | 2026-04-25 | Updated fee policy; added sanity checks              |
| 1.0     | 2026-01-29 | Initial release                                      |

---

## 17. Worked Examples

### 17.1 Rate Query

Fetch the current ACBU/NGN rate:

```bash
curl -X GET https://api.acbu.io/v1/rates/NGN \
  -H "Authorization: Bearer <api_key>"
```

```json
{
  "currency": "NGN",
  "acbu_per_ngn": "0.000997",
  "ngn_per_acbu": "1003.45",
  "timestamp": "2026-10-19T10:00:00Z"
}
```

### 17.2 Fee Estimation

Estimate fees before minting 500,000 NGN with healthy reserves (fee = 30 BPS):

```
fee_ngn    = 500,000 × 0.0030 = 1,500.00 NGN
net_ngn    = 500,000 − 1,500.00 = 498,500.00 NGN
gross_acbu = 498,500.00 ÷ 1,003.45 = 496.79 ACBU
```

### 17.3 Mint and Burn Examples

> These examples use the **0.30% mint fee** (30 BPS, healthy-reserve tier) and
> the **0.10% burn fee** (10 BPS, normal-reserve tier for GHS).
> All arithmetic is derived from the formulas in §12.

---

#### Mint Example — 500,000 NGN → ACBU

**Inputs**

| Field             | Value         |
|-------------------|---------------|
| Local amount      | 500,000 NGN   |
| Exchange rate     | 1,003.45 NGN/ACBU |
| Mint fee          | 30 BPS (0.30%) |

**Calculation**

```
fee_ngn     = 500,000 × 0.0030          = 1,500.00 NGN
net_ngn     = 500,000 − 1,500.00        = 498,500.00 NGN
expected_acbu = 498,500.00 ÷ 1,003.45  = 496.79 ACBU
```

**Expected API response**

```json
{
  "transaction_id": "a1b2c3d4-...",
  "currency": "NGN",
  "amount": "500000",
  "fee_local": "1500.00",
  "expected_acbu": "496.79",
  "status": "pending"
}
```

---

#### Burn Example — 500 ACBU → GHS

**Inputs**

| Field             | Value          |
|-------------------|----------------|
| ACBU amount       | 500 ACBU       |
| Exchange rate     | 15.27 GHS/ACBU |
| Burn fee          | 10 BPS (0.10%) |

**Calculation**

```
fee_acbu    = 500 × 0.0010              = 0.50 ACBU
net_acbu    = 500 − 0.50               = 499.50 ACBU
expected_ghs = 499.50 × 15.27          = 7,627.37 GHS
```

**Expected API response**

```json
{
  "transaction_id": "e5f6a7b8-...",
  "acbu_amount": "500",
  "currency": "GHS",
  "fee_acbu": "0.50",
  "expected_ghs": "7627.37",
  "status": "pending"
}
```

---

#### Verification: 0.997 Net-Factor Formula

Both examples can be verified with the compact net-factor formula
`net = gross × (1 − fee_rate)`:

- Mint: `500,000 NGN × 0.9970 ÷ 1,003.45 = 496.79 ACBU` ✓
- Burn: `500 ACBU × 0.9990 × 15.27 GHS/ACBU = 7,627.37 GHS` ✓

The fee rate for the two operations differs (0.30% mint vs 0.10% burn); use the
correct rate for each direction. Do not apply the mint fee to the burn leg or
vice versa.

---

*End of ACBU API Reference*
