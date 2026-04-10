/**
 * RiskManager - Protects capital from extreme conditions
 *
 * Guards:
 * - Extreme volatility spikes
 * - USDC reserve enforcement
 * - Per-pool capital limits
 * - Position cost vs fee efficiency check
 * - Allowed pool whitelist (ONLY HYPE-USDC and SOL-USDC)
 */

const logger = require('./logger');

const ALLOWED_POOLS = new Set(['SOL-USDC', 'HYPE-USDC']);

const RISK_CONFIG = {
  maxVolatilityPct:     parseFloat(process.env.MAX_VOL_PCT            || '5.0'),   // halt above 5% vol
  minUSDCReservePct:    parseFloat(process.env.MIN_USDC_RESERVE_PCT   || '0.10'),  // 10% reserve
  maxCapital_SOL_USDC:  parseFloat(process.env.MAX_CAPITAL_SOL_USDC   || '5000'),
  maxCapital_HYPE_USDC: parseFloat(process.env.MAX_CAPITAL_HYPE_USDC  || '3000'),
  minPositionCostUSD:   5.0, // $5 position creation cost, need to earn back
  minFeeEfficiencyHrs:  24,  // position must cover $5 cost within 24h
};

class RiskManager {
  constructor() {
    this.haltActive = false;
    this.haltReason = null;
    this.volatilityHistory = {};
  }

  /**
   * Evaluate current market conditions
   * Returns { halt: bool, reason: string }
   */
  async evaluate(prices) {
    for (const pool of Object.keys(prices)) {
      if (!ALLOWED_POOLS.has(pool)) continue;

      const vol = this._getVolatility(pool);

      // Extreme volatility halt
      if (vol > RISK_CONFIG.maxVolatilityPct) {
        this.haltActive = true;
        this.haltReason = `Extreme volatility on ${pool}: ${vol.toFixed(2)}%`;
        logger.warn(`🚨 RISK HALT: ${this.haltReason}`);
        return { halt: true, reason: this.haltReason };
      }
    }

    // Clear halt if conditions normalized
    if (this.haltActive) {
      logger.info('✅ Risk conditions normalized, resuming operations');
      this.haltActive = false;
      this.haltReason = null;
    }

    return { halt: false };
  }

  /**
   * Validate a new set of positions before opening
   */
  async validateNewPositions(config) {
    const { pool, positions, estimatedAPR } = config;

    // 1. Whitelist check
    if (!ALLOWED_POOLS.has(pool)) {
      return { ok: false, reason: `Pool ${pool} not in whitelist` };
    }

    // 2. Capital limit check
    const totalCapital = positions.reduce((s, p) => s + (p.capitalUSD || 0), 0);
    const maxCapital = RISK_CONFIG[`maxCapital_${pool.replace('-','_')}`];
    if (totalCapital > maxCapital) {
      return { ok: false, reason: `Capital $${totalCapital} exceeds max $${maxCapital}` };
    }

    // 3. APR feasibility (covers $5 position cost within 24h)
    if (estimatedAPR) {
      const dailyFeePct = parseFloat(estimatedAPR.dailyFeesPct);
      const minDailyPct = (RISK_CONFIG.minPositionCostUSD / totalCapital) * 100;
      if (dailyFeePct < minDailyPct) {
        return {
          ok: false,
          reason: `Expected daily fees ${dailyFeePct.toFixed(4)}% below minimum ${minDailyPct.toFixed(4)}% to cover position costs`
        };
      }
    }

    return { ok: true };
  }

  /**
   * Check USDC reserve is maintained
   */
  checkUSDCReserve(totalUSDC, allocatedUSDC) {
    const reservePct = (totalUSDC - allocatedUSDC) / totalUSDC;
    if (reservePct < RISK_CONFIG.minUSDCReservePct) {
      return {
        ok: false,
        reason: `USDC reserve ${(reservePct*100).toFixed(1)}% below minimum ${(RISK_CONFIG.minUSDCReservePct*100).toFixed(0)}%`,
        freeUSDC: totalUSDC * RISK_CONFIG.minUSDCReservePct
      };
    }
    return { ok: true };
  }

  setVolatility(pool, vol) {
    this.volatilityHistory[pool] = vol;
  }

  _getVolatility(pool) {
    return this.volatilityHistory[pool] || 0;
  }

  getStatus() {
    return {
      haltActive: this.haltActive,
      haltReason: this.haltReason,
      config: RISK_CONFIG,
      allowedPools: [...ALLOWED_POOLS],
    };
  }
}

module.exports = RiskManager;
