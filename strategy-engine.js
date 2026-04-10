/**
 * StrategyEngine - Calculates optimal LP ranges based on volatility + price
 *
 * Core Concepts:
 * - "Liquidity Gravity Well": concentrate more capital near current price
 * - Volatility-adaptive widths: wider range in high-vol, tighter in low-vol
 * - Sniper repositioning: ultra-tight range that trails price closely
 * - APR simulation before opening to validate profitability
 */

const logger = require('./logger');

// ── Pool-specific config limits ────────────────────────────────────────────
const POOL_CONFIG = {
  'SOL-USDC': {
    tickSpacing: 1,         // Meteora bin step (in basis points)
    feeRate: 0.0004,        // 0.04% fee tier
    minWidth: 0.005,        // 0.5% minimum range half-width
    maxWidth: 0.08,         // 8% maximum
    typicalDailyVol: 800_000, // USD daily volume estimate (for APR sim)
  },
  'HYPE-USDC': {
    tickSpacing: 2,
    feeRate: 0.001,         // 0.1% for higher-vol asset
    minWidth: 0.008,
    maxWidth: 0.15,
    typicalDailyVol: 200_000,
  }
};

// ── Volatility → range width multipliers ──────────────────────────────────
function volatilityToWidth(volatilityPct, pool) {
  const cfg = POOL_CONFIG[pool];
  // vol < 0.5%  → min width (tight market)
  // vol 0.5–2%  → linear scale 1.5–3%
  // vol > 2%    → max width (wide, protect from IL)
  const v = Math.max(0.1, Math.min(volatilityPct, 5));
  const ratio = (v - 0.1) / (5 - 0.1);
  const width = cfg.minWidth + ratio * (cfg.maxWidth - cfg.minWidth);
  return Math.max(cfg.minWidth, Math.min(cfg.maxWidth, width));
}

class StrategyEngine {

  // ── Build full position config for a given pool + price + strategy ──────
  buildPositionConfig(pool, currentPrice, strategyMode = '2-position') {
    const vol = this._getVolatility(pool);
    const baseWidth = volatilityToWidth(vol, pool);

    if (strategyMode === '3-position') {
      return this._build3Position(pool, currentPrice, baseWidth, vol);
    }
    return this._build2Position(pool, currentPrice, baseWidth, vol);
  }

  // ── 2-Position: Core + Sniper ──────────────────────────────────────────
  _build2Position(pool, price, baseWidth, vol) {
    const cfg = POOL_CONFIG[pool];

    // Core: wide safety net (±2–3× baseWidth)
    const coreWidth = Math.min(baseWidth * 2.5, cfg.maxWidth);
    // Sniper: ultra-tight (0.25–0.40 of baseWidth), dynamic
    const sniperWidth = this._calcSniperWidth(baseWidth, vol);

    const positions = [
      {
        name: 'core',
        type: 'core',
        lowerPrice: price * (1 - coreWidth),
        upperPrice: price * (1 + coreWidth),
        capitalPct: 0.40,   // 40% of pool capital
        priority: 1,
      },
      {
        name: 'sniper',
        type: 'sniper',
        lowerPrice: price * (1 - sniperWidth),
        upperPrice: price * (1 + sniperWidth),
        capitalPct: 0.60,   // 60% – tightest range earns most fees
        priority: 2,
      }
    ];

    return {
      pool,
      mode: '2-position',
      currentPrice: price,
      volatility: vol,
      baseWidth,
      positions,
      estimatedAPR: this.simulateAPR(pool, positions, price),
    };
  }

  // ── 3-Position: Core + Inner + Sniper ──────────────────────────────────
  _build3Position(pool, price, baseWidth, vol) {
    const cfg = POOL_CONFIG[pool];

    const coreWidth   = Math.min(baseWidth * 3.0, cfg.maxWidth);
    const innerWidth  = Math.min(baseWidth * 1.2, cfg.maxWidth * 0.6);
    const sniperWidth = this._calcSniperWidth(baseWidth, vol);

    const positions = [
      {
        name: 'core',
        type: 'core',
        lowerPrice: price * (1 - coreWidth),
        upperPrice: price * (1 + coreWidth),
        capitalPct: 0.25,
        priority: 1,
      },
      {
        name: 'inner',
        type: 'inner',
        lowerPrice: price * (1 - innerWidth),
        upperPrice: price * (1 + innerWidth),
        capitalPct: 0.35,
        priority: 2,
      },
      {
        name: 'sniper',
        type: 'sniper',
        lowerPrice: price * (1 - sniperWidth),
        upperPrice: price * (1 + sniperWidth),
        capitalPct: 0.40,
        priority: 3,
      }
    ];

    return {
      pool,
      mode: '3-position',
      currentPrice: price,
      volatility: vol,
      baseWidth,
      positions,
      estimatedAPR: this.simulateAPR(pool, positions, price),
    };
  }

  // ── Sniper width: ultra-tight, dynamically adjusted ────────────────────
  _calcSniperWidth(baseWidth, vol) {
    // Optimal range: 0.25–0.40 of baseWidth, clamped
    let ratio;
    if (vol < 0.3)      ratio = 0.25;  // very low vol → very tight
    else if (vol < 1.0) ratio = 0.30;
    else if (vol < 2.0) ratio = 0.35;
    else                ratio = 0.40;  // high vol → bit wider sniper

    return Math.max(0.002, baseWidth * ratio); // min 0.2% absolute
  }

  // ── APR Simulation ─────────────────────────────────────────────────────
  // Estimates APR based on: fee tier × volume × (concentration multiplier)
  simulateAPR(pool, positions, currentPrice) {
    const cfg = POOL_CONFIG[pool];
    const totalCapital = 10_000; // simulate with $10k for normalization

    let totalExpectedDailyFees = 0;

    for (const pos of positions) {
      const capitalUSD = totalCapital * pos.capitalPct;
      const rangeWidth = (pos.upperPrice - pos.lowerPrice) / currentPrice;

      // Concentration multiplier: tighter range = more fees per $ of capital
      // A position covering 1% of price range is ~100× concentrated vs full range
      const concentrationMult = Math.min(200, 0.02 / rangeWidth);

      // Expected daily fee = volume × fee_rate × (capital / total_pool_tvl)
      // We approximate pool TVL at 50×capital (conservative)
      const poolTVL = totalCapital * 50;
      const liquidityShare = capitalUSD / poolTVL;
      const dailyFees = cfg.typicalDailyVol * cfg.feeRate * liquidityShare * concentrationMult;

      totalExpectedDailyFees += dailyFees;
    }

    const dailyAPR = (totalExpectedDailyFees / totalCapital) * 100;
    const annualAPR = dailyAPR * 365;

    return {
      dailyFeesPct: dailyAPR.toFixed(4),
      annualAPR: annualAPR.toFixed(2),
      feasible: annualAPR > 10 // minimum 10% APR to justify $5 position cost
    };
  }

  // ── Check if sniper should be repositioned ─────────────────────────────
  shouldRepositionSniper(sniperPosition, currentPrice) {
    const { lowerPrice, upperPrice } = sniperPosition;
    const mid = (lowerPrice + upperPrice) / 2;
    const width = upperPrice - lowerPrice;

    // Reposition if price is outside sniper OR if drifted >30% from center
    const outOfRange = currentPrice < lowerPrice || currentPrice > upperPrice;
    const driftPct = Math.abs(currentPrice - mid) / (width / 2);
    const drifted = driftPct > 0.5; // price is in outer 50% of range

    return {
      reposition: outOfRange || drifted,
      reason: outOfRange ? 'out-of-range' : drifted ? 'drift' : null
    };
  }

  // ── Identify high-swap-volume zones from price history ─────────────────
  calcLiquidityGravityZones(priceHistory, currentPrice) {
    if (!priceHistory || priceHistory.length < 10) {
      return { center: currentPrice, weight: 1.0 };
    }

    // Find price levels with high frequency (gravity wells)
    const bucketSize = currentPrice * 0.001; // 0.1% buckets
    const buckets = {};

    for (const { price } of priceHistory) {
      const bucket = Math.round(price / bucketSize);
      buckets[bucket] = (buckets[bucket] || 0) + 1;
    }

    // Find top 3 most visited price levels
    const sorted = Object.entries(buckets)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3);

    const topLevels = sorted.map(([bucket, count]) => ({
      price: parseInt(bucket) * bucketSize,
      count,
      weight: count / priceHistory.length
    }));

    // Weighted center of gravity
    const totalWeight = topLevels.reduce((s, l) => s + l.count, 0);
    const gravityCenter = topLevels.reduce((s, l) => s + l.price * l.count, 0) / totalWeight;

    return { center: gravityCenter, levels: topLevels };
  }

  _getVolatility(pool) {
    // Will be overridden by agent with real volatility from PriceMonitor
    return parseFloat(process.env[`${pool.replace('-','_')}_VOL`] || '1.0');
  }

  setVolatility(pool, vol) {
    this[`_vol_${pool}`] = vol;
    this._getVolatility = (p) => this[`_vol_${p}`] || 1.0;
  }

  // ── Format config for display ──────────────────────────────────────────
  describeConfig(config) {
    const lines = [
      `📊 ${config.pool} | ${config.mode} | Volatility: ${config.volatility?.toFixed(3)}%`,
      `💲 Current Price: $${config.currentPrice?.toFixed(4)}`,
      `📈 Est. APR: ${config.estimatedAPR?.annualAPR}%`,
      '',
      ...config.positions.map(p =>
        `  [${p.name.toUpperCase()}] $${p.lowerPrice.toFixed(4)} – $${p.upperPrice.toFixed(4)} | Capital: ${(p.capitalPct*100).toFixed(0)}%`
      )
    ];
    return lines.join('\n');
  }
}

module.exports = StrategyEngine;
