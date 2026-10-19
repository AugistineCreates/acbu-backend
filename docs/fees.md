# ACBU Fee Policy Documentation

## Overview

The ACBU platform implements a dynamic fee structure that adjusts based on reserve health and currency-specific reserve weights. This document maps the code-level implementation to the business requirements.

## Fee Types

### 1. Mint Fees

Mint fees are charged when users convert fiat currency to ACBU tokens. The fee adjusts based on the overall reserve ratio to discourage minting when reserves are stressed.

#### Fee Tiers

| Reserve Ratio | Fee (BPS) | Fee (%) | Business Logic |
|--------------|-----------|---------|----------------|
| ≥ 1.02 (minRatio) | 30 | 0.30% | Normal operations - healthy reserves |
| < 1.02 (minRatio) | 50 | 0.50% | Stressed reserves - discourage new minting |
| Maximum Cap | 100 | 1.00% | Hard cap to prevent excessive fees |

#### Code Constants

```typescript
// Location: src/services/feePolicy/feePolicyService.ts
const BASE_MINT_FEE_BPS = 30;           // Normal fee
const STRESSED_MINT_FEE_BPS = 50;       // Low reserve fee
const MAX_MINT_FEE_BPS = 100;           // Maximum cap
```

#### Implementation

```typescript
export async function getMintFeeBps(_currency?: string): Promise<number>
```

The function:
1. Calculates the current reserve ratio (total reserves / total ACBU supply)
2. Compares against `config.reserve.minRatio` (1.02)
3. Returns appropriate fee tier
4. Applies maximum cap
5. Validates fee is within sanity bounds [1, 500] BPS

### 2. Burn Fees

Burn fees are charged when users convert ACBU tokens back to fiat currency. The fee adjusts per currency based on that currency's reserve weight relative to its target weight in the basket.

#### Fee Tiers

| Reserve Weight (% of Target) | Fee (BPS) | Fee (%) | Business Logic |
|------------------------------|-----------|---------|----------------|
| < 85% | 200 | 2.00% | Low reserves - strongly discourage burns |
| 85% - 115% | 30 | 0.30% | Normal range - standard fee |
| > 115% | 5 | 0.05% | High reserves - encourage burns for rebalancing |

#### Code Constants

```typescript
// Location: src/services/feePolicy/feePolicyService.ts
const BASE_BURN_FEE_BPS = 30;           // Normal fee (85-115%)
const LOW_RESERVE_BURN_FEE_BPS = 200;   // Low reserve fee (<85%)
const HIGH_RESERVE_BURN_FEE_BPS = 5;    // High reserve fee (>115%)
const LOW_RESERVE_THRESHOLD_PCT = 85;   // Lower boundary
const HIGH_RESERVE_THRESHOLD_PCT = 115; // Upper boundary
```

#### Implementation

```typescript
export async function getBurnFeeBps(currency: string): Promise<number>
```

The function:
1. Retrieves current reserve status for the specified currency
2. Calculates `pctOfTarget = (actualWeight / targetWeight) * 100`
3. Applies appropriate fee tier based on thresholds
4. Validates fee is within sanity bounds [1, 500] BPS
5. Throws error if currency not found or target weight invalid

### 3. Spread

The spread is applied to exchange rates for buy/sell operations.

| Parameter | Value (BPS) | Value (%) | Description |
|-----------|-------------|-----------|-------------|
| Default Spread | 25 | 0.25% | Applied symmetrically to mid-rate |

#### Code Constants

```typescript
const DEFAULT_SPREAD_BPS = Number(process.env.SPREAD_BPS || "25");
```

#### Implementation

```typescript
export function applySpread(midRate: number): { buyRate: number; sellRate: number }
```

The function:
- Buy Rate: `midRate * (1 - spread/2)` - User pays slightly more
- Sell Rate: `midRate * (1 + spread/2)` - User receives slightly less

## Economic Incentives

### Mint Fee Logic

The mint fee structure creates the following incentives:

1. **Healthy Reserves (ratio ≥ 1.02)**: Low fee (30 BPS) encourages minting
2. **Stressed Reserves (ratio < 1.02)**: Higher fee (50 BPS) discourages minting until reserves recover

This protects the system from becoming under-collateralized.

### Burn Fee Logic

The burn fee structure creates currency-specific rebalancing incentives:

1. **Low Reserves (<85% of target)**: High fee (200 BPS / 2.00%) strongly discourages withdrawals of scarce currencies
2. **Normal Reserves (85-115%)**: Standard base fee (30 BPS / 0.30%) applies for normal operations
3. **High Reserves (>115%)**: Discounted low fee (5 BPS / 0.05%) encourages withdrawals to rebalance the basket

This automatically incentivizes users to help maintain the target basket composition.

### Rebalancing Fee Model vs Flat Fee Model Alignment

The ACBU architecture clarifies the distinction between user-facing operations, operational reserve rebalancing, and fee structures:

- **Baseline / Standard Fee**: The core transaction fee across general documentation, user flows, and pricing formulas is standard **0.30% (30 BPS)** for both minting and burning in normal operating conditions (reserve ratio ≥ 1.02 and currency reserve weight between 85% and 115% of target).
- **Operational Dynamic Rebalancing**: Rather than applying opaque variable fees (+/- 0.5% arbitrary discounts/penalties), all dynamic adjustments are strictly governed by reserve thresholds:
  - **Minting**: 30 BPS (healthy reserves ≥ 1.02) to 50 BPS (stressed reserves < 1.02), capped at 100 BPS.
  - **Burning / Withdrawals**: 30 BPS standard, 5 BPS discount for high-reserve currencies (>115% of target) to incentivize outflows, and 200 BPS penalty for low-reserve currencies (<85% of target) to protect liquidity.
  - **Automated Protocol Rebalancing**: Daily operational rebalancing (executed at 00:00 UTC by `RebalancingEngine`) performs protocol-level swaps via fintech partner liquidity and does not charge hidden ad-hoc fees to regular user transfers.

All user flows and API quotes surface the exact effective fee dynamically retrieved via `getMintFeeBps()` and `getBurnFeeBps(currency)` before transaction execution.

## Sanity Checks

All fee calculations include runtime sanity checks to prevent catastrophic errors:

```typescript
const MIN_SANITY_FEE_BPS = 1;    // 0.01% minimum
const MAX_SANITY_FEE_BPS = 500;  // 5.00% maximum
```

If a calculated fee falls outside this range, the service throws an error rather than returning an invalid fee.

## Testing Strategy

### Unit Tests

Standard unit tests verify:
- Correct fee for each tier
- Boundary conditions at exact thresholds
- Error handling for invalid inputs

Location: `src/services/feePolicy/__tests__/feePolicyService.test.ts`

### Property-Based Tests

Property-based tests verify mathematical properties:
- **Monotonicity**: Fees follow expected direction as reserves change
- **Boundaries**: Exact threshold behavior is consistent
- **Sanity**: All fees are within acceptable bounds
- **Determinism**: Same inputs always produce same outputs
- **Cap Enforcement**: Fees never exceed maximum limits

Location: `src/services/feePolicy/__tests__/feePolicyService.pbt.test.ts`

To run property-based tests:
```bash
pnpm add -D fast-check
pnpm test -- feePolicyService.pbt.test.ts
```

## Configuration

Fee parameters can be adjusted via environment variables:

```bash
# Spread (default: 25 BPS = 0.25%)
SPREAD_BPS=25

# Reserve thresholds (used by mint fee logic)
RESERVE_MIN_RATIO=1.02
RESERVE_TARGET_RATIO=1.05
RESERVE_ALERT_THRESHOLD=1.02
```

## Audit Trail

### Version History

| Date | Version | Changes | Auditor |
|------|---------|---------|---------|
| 2026-10-19 | 2.1 | Reconciled fee model: explicitly documented operational rebalancing mechanics vs flat 0.30% base fee, clarifying discount/penalty dynamics. | Systems Architect |
| 2026-04-25 | 2.0 | Fixed burn fee logic: Changed high reserve fee from 10 to 5 BPS. Added sanity checks. Added fail-fast error handling. | Senior Backend Engineer |
| 2026-01-29 | 1.0 | Initial implementation | - |

### Key Fixes in v2.0

1. **Burn Fee Correction**: High reserve tier (>115%) now correctly returns 5 BPS instead of 10 BPS
2. **Sanity Checks**: Added runtime validation to prevent fees outside [1, 500] BPS range
3. **Fail-Fast**: Service now throws errors for invalid states instead of returning default values
4. **Property-Based Testing**: Added comprehensive PBT suite to catch edge cases
5. **Documentation**: Created this mapping document for easier auditing

### Before and After

#### Burn Fee Logic (High Reserve Case)

**Before:**
```typescript
if (pctOfTarget > HIGH_RESERVE_THRESHOLD_PCT)
  return HIGH_RESERVE_BURN_FEE_BPS; // Was 10 BPS - WRONG!
```

**After:**
```typescript
if (pctOfTarget > HIGH_RESERVE_THRESHOLD_PCT) {
  // High reserves: encourage burns with low fee
  feeBps = HIGH_RESERVE_BURN_FEE_BPS; // Now 5 BPS - CORRECT!
}
```

**Impact**: Users with high-reserve currencies now pay 5 BPS instead of 10 BPS, correctly incentivizing rebalancing.

#### Error Handling

**Before:**
```typescript
if (!curr) return BASE_BURN_FEE_BPS; // Silent fallback
if (targetWeight <= 0) return BASE_BURN_FEE_BPS; // Silent fallback
```

**After:**
```typescript
if (!curr) {
  throw new Error(`Currency ${currency} not found in reserve status. Cannot calculate burn fee.`);
}
if (targetWeight <= 0) {
  throw new Error(`Invalid target weight for ${currency}: ${targetWeight}. Cannot calculate burn fee.`);
}
```

**Impact**: System now fails explicitly when encountering invalid states, preventing incorrect fee calculations.

## Maintenance

When updating fee tiers:

1. Update constants in `src/services/feePolicy/feePolicyService.ts`
2. Update this documentation table
3. Update unit tests in `__tests__/feePolicyService.test.ts`
4. Run property-based tests to verify mathematical properties still hold
5. Update the audit trail with date, version, and changes
6. Review with financial/compliance team before deploying

## Contact

For questions about fee policy:
- Technical: Backend Engineering Team
- Business Logic: Product/Finance Team
- Compliance: Legal/Compliance Team
