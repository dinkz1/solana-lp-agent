/**
 * CompoundEngine - Fee reinvestment with configurable allocation
 *
 * Modes:
 * - balanced (default): 50% reinvest, 30% USDC reserve, 20% profit
 * - aggressive:         100% reinvest
 * - conservative:       30% reinvest, 50% USDC reserve, 20% profit
 */

const logger = require('./logger');

const COMPOUND_STRATEGIES = {
  balanced: {
    reinvestPct: 0.50,
    reservePct:  0.30,
    profitPct:   0.20,
  },
  aggressive: {
    reinvestPct: 1.00,
    reservePct:  0.00,
    profitPct:   0.00,
  },
  conservative: {
    reinvestPct: 0.30,
    reservePct:  0.50,
    profitPct:   0.20,
  }
};

class CompoundEngine {
  constructor() {
    this.compoundLog = [];
  }

  async compound(position, fees, mode = 'balanced') {
    if (fees.totalUSD <= 0) return null;

    const strategy = COMPOUND_STRATEGIES[mode] || COMPOUND_STRATEGIES.balanced;
    const { totalUSD } = fees;

    const allocation = {
      reinvest: totalUSD * strategy.reinvestPct,
      reserve:  totalUSD * strategy.reservePct,
      profit:   totalUSD * strategy.profitPct,
    };

    logger.info(
      `💰 Compounding $${totalUSD.toFixed(2)} from ${position.pool} ${position.name} | ` +
      `Reinvest: $${allocation.reinvest.toFixed(2)} | ` +
      `Reserve: $${allocation.reserve.toFixed(2)} | ` +
      `Profit: $${allocation.profit.toFixed(2)}`
    );

    const record = {
      ts: Date.now(),
      pool: position.pool,
      positionId: position.id,
      totalUSD,
      mode,
      allocation,
    };

    this.compoundLog.push(record);
    // Keep last 1000 records
    if (this.compoundLog.length > 1000) this.compoundLog.shift();

    return record;
  }

  getCompoundStats(pool, days = 7) {
    const since = Date.now() - days * 86400000;
    const records = this.compoundLog.filter(r => r.ts >= since && (!pool || r.pool === pool));

    const totalReinvested = records.reduce((s, r) => s + r.allocation.reinvest, 0);
    const totalProfit = records.reduce((s, r) => s + r.allocation.profit, 0);
    const totalFees = records.reduce((s, r) => s + r.totalUSD, 0);

    return {
      period: `${days}d`,
      totalFees: totalFees.toFixed(2),
      totalReinvested: totalReinvested.toFixed(2),
      totalProfit: totalProfit.toFixed(2),
      count: records.length,
    };
  }
}

module.exports = CompoundEngine;
