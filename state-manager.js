/**
 * StateManager - Persists agent state to JSON file
 * Tracks positions, strategies, earnings, and settings
 */

const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

const STATE_FILE = path.join(__dirname, '../data/state.json');

const DEFAULT_STATE = {
  positions: [],
  strategies: {
    'SOL-USDC':  '2-position',
    'HYPE-USDC': '2-position',
  },
  prices: {},
  compoundMode: 'balanced',
  earnings: {
    'SOL-USDC':  { totalUSD: 0, dailyUSD: 0, lastReset: Date.now() },
    'HYPE-USDC': { totalUSD: 0, dailyUSD: 0, lastReset: Date.now() },
  },
  rebalanceCount: 0,
  startedAt: Date.now(),
};

class StateManager {
  constructor() {
    this.state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    this.dirty = false;
  }

  async load() {
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      const raw = await fs.readFile(STATE_FILE, 'utf8');
      this.state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      logger.info(`State loaded: ${this.state.positions.length} positions`);
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn('State load error:', err.message);
      logger.info('Starting with fresh state');
    }
  }

  async save() {
    if (!this.dirty) return;
    try {
      await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
      await fs.writeFile(STATE_FILE, JSON.stringify(this.state, null, 2));
      this.dirty = false;
    } catch (err) {
      logger.error('State save error:', err.message);
    }
  }

  // ── Positions ──────────────────────────────────────────────────────────
  async getPositions(pool = null) {
    if (pool) return this.state.positions.filter(p => p.pool === pool);
    return this.state.positions;
  }

  async setPositions(pool, positions) {
    this.state.positions = [
      ...this.state.positions.filter(p => p.pool !== pool),
      ...positions,
    ];
    this.dirty = true;
  }

  async updatePositionStats(id, stats) {
    const pos = this.state.positions.find(p => p.id === id);
    if (!pos) return;
    Object.assign(pos, stats);
    this.dirty = true;

    // Update earnings
    if (stats.fees?.totalUSD && pos.pool) {
      const earn = this.state.earnings[pos.pool];
      if (earn) {
        earn.totalUSD = Math.max(earn.totalUSD, stats.fees.totalUSD);
      }
    }
  }

  // ── Strategy ───────────────────────────────────────────────────────────
  async getStrategy(pool) {
    return this.state.strategies[pool] || '2-position';
  }

  async setStrategy(pool, strategy) {
    this.state.strategies[pool] = strategy;
    this.dirty = true;
  }

  // ── Prices ────────────────────────────────────────────────────────────
  async updatePrices(prices) {
    this.state.prices = { ...this.state.prices, ...prices };
    this.dirty = true;
  }

  // ── Compound mode ─────────────────────────────────────────────────────
  async getCompoundMode() {
    return this.state.compoundMode;
  }

  async setCompoundMode(mode) {
    this.state.compoundMode = mode;
    this.dirty = true;
  }

  // ── Summary ───────────────────────────────────────────────────────────
  getSummary() {
    const now = Date.now();
    const uptimeHrs = (now - this.state.startedAt) / 3600000;

    const positionSummary = this.state.positions.map(p => ({
      pool: p.pool,
      type: p.type,
      lowerPrice: p.lowerPrice?.toFixed(4),
      upperPrice: p.upperPrice?.toFixed(4),
      capitalUSD: p.capitalUSD?.toFixed(2),
      inRange: p.inRange,
      feesEarnedUSD: p.feesEarnedUSD?.toFixed(4),
    }));

    return {
      positions: positionSummary,
      strategies: this.state.strategies,
      prices: this.state.prices,
      compoundMode: this.state.compoundMode,
      earnings: this.state.earnings,
      uptimeHrs: uptimeHrs.toFixed(1),
      rebalanceCount: this.state.rebalanceCount,
    };
  }

  incrementRebalance() {
    this.state.rebalanceCount = (this.state.rebalanceCount || 0) + 1;
    this.dirty = true;
  }
}

module.exports = StateManager;
