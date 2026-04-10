/**
 * RebalanceEngine - Smart rebalancing logic
 *
 * Key features:
 * - Cooldown system to prevent over-trading
 * - Breakout vs ranging market detection
 * - 5–15 minute delay to avoid fake breakouts
 * - Sniper repositioning when price exits narrow range
 */

const logger = require('./logger');

// ── Constants ───────────────────────────────────────────────────────────────
const REBALANCE_THRESHOLD   = parseFloat(process.env.REBALANCE_THRESHOLD   || '0.012'); // 1.2%
const BREAKOUT_THRESHOLD    = parseFloat(process.env.BREAKOUT_THRESHOLD    || '0.025'); // 2.5%
const COOLDOWN_MS           = parseInt(process.env.COOLDOWN_MS             || '900000'); // 15 min
const FAKEOUT_DELAY_MS      = parseInt(process.env.FAKEOUT_DELAY_MS        || '600000'); // 10 min
const SNIPER_REBAL_THRESHOLD = 0.003; // 0.3% – sniper repositions faster

class RebalanceEngine {
  constructor() {
    // Per-pool cooldown tracking
    this.lastRebalance = {};
    // Pending rebalance signals (for fakeout delay)
    this.pendingSignals = {};
  }

  /**
   * Main decision function: should we rebalance this pool?
   * Returns { rebalance: bool, reason: string, urgent: bool }
   */
  async shouldRebalance(pool, currentPrice, positions) {
    if (!positions || positions.length === 0) {
      return { rebalance: true, reason: 'no-positions', urgent: false };
    }

    // 1. Check cooldown
    const cooldownRemaining = this._cooldownRemaining(pool);
    if (cooldownRemaining > 0) {
      logger.debug(`${pool} in cooldown: ${(cooldownRemaining/60000).toFixed(1)}min remaining`);
      return { rebalance: false, reason: 'cooldown', cooldownRemaining };
    }

    // 2. Check each position type
    const corePos    = positions.find(p => p.type === 'core');
    const sniperPos  = positions.find(p => p.type === 'sniper');
    const innerPos   = positions.find(p => p.type === 'inner');

    // 3. Core out-of-range → urgent full rebalance
    if (corePos && !this._inRange(corePos, currentPrice)) {
      return { rebalance: true, reason: 'core-out-of-range', urgent: true };
    }

    // 4. Sniper out-of-range → reposition sniper quickly (no fakeout delay)
    if (sniperPos && !this._inRange(sniperPos, currentPrice)) {
      logger.info(`${pool}: Sniper out of range, repositioning`);
      return { rebalance: true, reason: 'sniper-out-of-range', urgent: false, sniperOnly: true };
    }

    // 5. Sniper drift check (price in outer 30% of sniper range)
    if (sniperPos) {
      const drift = this._calcDrift(sniperPos, currentPrice);
      if (drift > 0.6) {
        logger.info(`${pool}: Sniper drift ${(drift*100).toFixed(1)}%, repositioning`);
        return { rebalance: true, reason: 'sniper-drift', urgent: false, sniperOnly: true };
      }
    }

    // 6. Core center drift check with fakeout protection
    if (corePos) {
      const centerDrift = this._calcCenterDrift(corePos, currentPrice);
      if (centerDrift > REBALANCE_THRESHOLD) {
        const signal = this._checkFakeoutDelay(pool, 'core-drift', currentPrice);
        if (signal.confirmed) {
          const isBreakout = this._detectBreakout(pool, currentPrice, positions);
          return {
            rebalance: true,
            reason: isBreakout ? 'breakout-detected' : 'core-center-drift',
            urgent: isBreakout,
            sniperOnly: false,
          };
        } else {
          logger.debug(`${pool}: Drift ${(centerDrift*100).toFixed(2)}% — waiting for fakeout confirmation (${(signal.waitMs/60000).toFixed(1)}min)`);
          return { rebalance: false, reason: 'fakeout-delay', waitMs: signal.waitMs };
        }
      } else {
        // Clear pending signal if price returned to center
        this._clearPendingSignal(pool, 'core-drift');
      }
    }

    return { rebalance: false, reason: 'in-range' };
  }

  // ── Breakout detection ─────────────────────────────────────────────────
  // Returns true if price movement is sustained + significant
  _detectBreakout(pool, currentPrice, positions) {
    const corePos = positions.find(p => p.type === 'core');
    if (!corePos) return false;

    const drift = this._calcCenterDrift(corePos, currentPrice);
    if (drift > BREAKOUT_THRESHOLD) {
      logger.info(`${pool}: Breakout detected! Drift: ${(drift*100).toFixed(2)}%`);
      return true;
    }
    return false;
  }

  // ── Fakeout delay system ───────────────────────────────────────────────
  // Returns whether the signal has been pending long enough to be real
  _checkFakeoutDelay(pool, signalType, currentPrice) {
    const key = `${pool}:${signalType}`;
    const now = Date.now();

    if (!this.pendingSignals[key]) {
      // First time seeing this signal, start timer
      this.pendingSignals[key] = {
        firstSeen: now,
        initialPrice: currentPrice
      };
    }

    const elapsed = now - this.pendingSignals[key].firstSeen;
    const waitMs = Math.max(0, FAKEOUT_DELAY_MS - elapsed);

    if (elapsed >= FAKEOUT_DELAY_MS) {
      delete this.pendingSignals[key];
      return { confirmed: true, waitMs: 0 };
    }

    return { confirmed: false, waitMs };
  }

  _clearPendingSignal(pool, signalType) {
    const key = `${pool}:${signalType}`;
    if (this.pendingSignals[key]) {
      delete this.pendingSignals[key];
      logger.debug(`Cleared pending signal: ${key}`);
    }
  }

  // ── Cooldown management ────────────────────────────────────────────────
  setCooldown(pool) {
    this.lastRebalance[pool] = Date.now();
    logger.info(`${pool}: Cooldown set for ${COOLDOWN_MS/60000}min`);
  }

  _cooldownRemaining(pool) {
    if (!this.lastRebalance[pool]) return 0;
    const elapsed = Date.now() - this.lastRebalance[pool];
    return Math.max(0, COOLDOWN_MS - elapsed);
  }

  // ── Range helpers ──────────────────────────────────────────────────────
  _inRange(position, price) {
    return price >= position.lowerPrice && price <= position.upperPrice;
  }

  // Returns 0–1 where 1 = at edge of range
  _calcDrift(position, price) {
    const mid = (position.lowerPrice + position.upperPrice) / 2;
    const halfWidth = (position.upperPrice - position.lowerPrice) / 2;
    if (halfWidth === 0) return 1;
    return Math.abs(price - mid) / halfWidth;
  }

  // Returns % drift from center
  _calcCenterDrift(position, price) {
    const mid = (position.lowerPrice + position.upperPrice) / 2;
    return Math.abs(price - mid) / mid;
  }

  // ── Get status summary ─────────────────────────────────────────────────
  getStatus() {
    return {
      cooldowns: Object.fromEntries(
        Object.entries(this.lastRebalance).map(([pool, ts]) => [
          pool,
          { lastRebalance: new Date(ts).toISOString(), cooldownRemaining: this._cooldownRemaining(pool) }
        ])
      ),
      pendingSignals: Object.keys(this.pendingSignals),
    };
  }
}

module.exports = RebalanceEngine;
