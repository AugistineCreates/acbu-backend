import Decimal from "decimal.js";

/**
 * Interface representing a fintech/banking partner holding segregated operational reserves.
 */
export interface PartnerSegregatedReserve {
  partnerId: string;
  partnerName: string;
  currency: string;
  reserveAmountLocal: Decimal;
  reserveAmountUsd: Decimal;
  /** Whether ACBU has a ratified Partner Reserve & Interest Agreement (PRIA) establishing entitlement */
  hasContractualEntitlement: boolean;
  agreementReference?: string;
  /** Percentage of interest retained by partner for regulatory capital / operational costs (in basis points) */
  partnerRetentionBps: number;
  /** Percentage of interest remitted to ACBU protocol (in basis points) */
  protocolShareBps: number;
  /** Estimated annual interest rate on the account (in basis points, e.g. 800 = 8.00%) */
  annualYieldRateBps: number;
}

export interface RevenueProjectionInputs {
  annualizedVolumeUsd: Decimal;
  /** Blended take-rate across mint/burn and transaction routes in basis points (e.g. 95 bps = 0.95%) */
  blendedTakeRateBps: number;
  /** Protocol yield earned from deployed investment_savings segment (not operational partner float) */
  investmentSavingsYieldUsd: Decimal;
  /** List of partner-held segregated reserve balances */
  partnerReserves: PartnerSegregatedReserve[];
}

export interface RevenueProjectionResult {
  transactionFeeRevenueUsd: Decimal;
  investmentSavingsYieldUsd: Decimal;
  /** Float interest recognized under strict contractual entitlement rules */
  recognizedFloatInterestUsd: Decimal;
  /** Gross interest accrued on segregated partner float (earned by partner or protocol) */
  grossPartnerFloatInterestUsd: Decimal;
  /** Interest retained by partners due to lack of entitlement or contractual split */
  partnerRetainedInterestUsd: Decimal;
  totalProtocolRevenueUsd: Decimal;
  isConservativeBaseline: boolean;
}

export interface BreakevenAnalysisInputs {
  annualOperatingExpensesUsd: Decimal;
  blendedTakeRateBps: number;
  confirmedFloatInterestUsd?: Decimal;
  investmentSavingsYieldUsd?: Decimal;
}

export interface BreakevenAnalysisResult {
  annualOperatingExpensesUsd: Decimal;
  confirmedFloatInterestUsd: Decimal;
  investmentSavingsYieldUsd: Decimal;
  netRevenueRequiredFromVolumeUsd: Decimal;
  requiredAnnualVolumeUsd: Decimal;
  blendedTakeRateBps: number;
}

/**
 * Service to calculate and govern float-interest revenue, enforce contractual entitlement
 * on partner-held segregated reserves, and project audited breakeven metrics (W10-S-012).
 */
export class FloatRevenueService {
  /**
   * Calculates the recognized float interest for a single partner reserve.
   *
   * RULE (W10-S-012):
   * If hasContractualEntitlement is false, interest on segregated partner accounts
   * accrues to the partner / custodian under banking norms, resulting in $0 protocol revenue.
   * Only when a ratified PRIA exists is the contractual protocol share recognized.
   */
  public static calculatePartnerFloatYield(reserve: PartnerSegregatedReserve): {
    grossInterestUsd: Decimal;
    protocolYieldUsd: Decimal;
    partnerYieldUsd: Decimal;
  } {
    const yieldRate = new Decimal(reserve.annualYieldRateBps).div(10000);
    const grossInterestUsd = reserve.reserveAmountUsd.mul(yieldRate);

    if (!reserve.hasContractualEntitlement) {
      // All interest accrues to the partner
      return {
        grossInterestUsd,
        protocolYieldUsd: new Decimal(0),
        partnerYieldUsd: grossInterestUsd,
      };
    }

    const protocolShare = new Decimal(reserve.protocolShareBps).div(10000);
    const protocolYieldUsd = grossInterestUsd.mul(protocolShare);
    const partnerYieldUsd = grossInterestUsd.minus(protocolYieldUsd);

    return {
      grossInterestUsd,
      protocolYieldUsd,
      partnerYieldUsd,
    };
  }

  /**
   * Computes revenue projections under the conservative baseline model (ignoring unentitled float)
   * or under contractual best-case entitlement.
   */
  public static calculateRevenueProjection(
    inputs: RevenueProjectionInputs,
    forceZeroFloatInterest = false,
  ): RevenueProjectionResult {
    const takeRate = new Decimal(inputs.blendedTakeRateBps).div(10000);
    const transactionFeeRevenueUsd = inputs.annualizedVolumeUsd.mul(takeRate);

    let grossPartnerFloatInterestUsd = new Decimal(0);
    let recognizedFloatInterestUsd = new Decimal(0);
    let partnerRetainedInterestUsd = new Decimal(0);

    for (const reserve of inputs.partnerReserves) {
      const { grossInterestUsd, protocolYieldUsd, partnerYieldUsd } =
        this.calculatePartnerFloatYield(reserve);

      grossPartnerFloatInterestUsd = grossPartnerFloatInterestUsd.plus(grossInterestUsd);

      if (forceZeroFloatInterest) {
        partnerRetainedInterestUsd = partnerRetainedInterestUsd.plus(grossInterestUsd);
      } else {
        recognizedFloatInterestUsd = recognizedFloatInterestUsd.plus(protocolYieldUsd);
        partnerRetainedInterestUsd = partnerRetainedInterestUsd.plus(partnerYieldUsd);
      }
    }

    const totalProtocolRevenueUsd = transactionFeeRevenueUsd
      .plus(inputs.investmentSavingsYieldUsd)
      .plus(recognizedFloatInterestUsd);

    return {
      transactionFeeRevenueUsd,
      investmentSavingsYieldUsd: inputs.investmentSavingsYieldUsd,
      recognizedFloatInterestUsd,
      grossPartnerFloatInterestUsd,
      partnerRetainedInterestUsd,
      totalProtocolRevenueUsd,
      isConservativeBaseline: forceZeroFloatInterest || recognizedFloatInterestUsd.isZero(),
    };
  }

  /**
   * Re-runs the breakeven calculation based on operating expenses and verified non-volume revenue.
   *
   * Demonstrates the core impact of W10-S-012:
   * When uncontracted $3-5M float interest is removed, the required transaction volume
   * to cover $4.2M OpEx shifts from ~$380M to ~$442M (assuming ~95 bps take rate).
   */
  public static calculateBreakevenVolume(inputs: BreakevenAnalysisInputs): BreakevenAnalysisResult {
    const confirmedFloatInterest = inputs.confirmedFloatInterestUsd ?? new Decimal(0);
    const investmentYield = inputs.investmentSavingsYieldUsd ?? new Decimal(0);
    const otherRevenue = confirmedFloatInterest.plus(investmentYield);

    // Net operating expenses that must be funded through transaction fee volume
    const netRevenueRequired = Decimal.max(
      new Decimal(0),
      inputs.annualOperatingExpensesUsd.minus(otherRevenue),
    );

    const takeRate = new Decimal(inputs.blendedTakeRateBps).div(10000);
    const requiredAnnualVolumeUsd = takeRate.isZero()
      ? new Decimal(0)
      : netRevenueRequired.div(takeRate);

    return {
      annualOperatingExpensesUsd: inputs.annualOperatingExpensesUsd,
      confirmedFloatInterestUsd: confirmedFloatInterest,
      investmentSavingsYieldUsd: investmentYield,
      netRevenueRequiredFromVolumeUsd: netRevenueRequired,
      requiredAnnualVolumeUsd,
      blendedTakeRateBps: inputs.blendedTakeRateBps,
    };
  }
}
