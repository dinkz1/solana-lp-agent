/**
 * Solana LP Agent - Main Entry Point
 * Manages HYPE-USDC and SOL-USDC concentrated liquidity positions
 */

require('dotenv').config();
const logger = require('./logger');
const PriceMonitor = require('./price-monitor');
const StrategyEngine = require('./strategy-engine');
const LPManager = require('./lp-manager');
const RebalanceEngine = require('./rebalance-engine');
const RiskManager = require('./risk-manager');
const CompoundEngine = require('./compound-engine');
const TelegramBot = require('./telegram-bot');
const StateManager = require('./state-manager');

class LPAgent {
  constructor() {
    this.isRunning = false;
    this.state = new StateManager();
    this.priceMonitor = new PriceMonitor();
    this.strategyEngine = new StrategyEngine();
    this.lpManager = new LPManager();
    this.rebalanceEngine = new RebalanceEngine();
    this.riskManager = new RiskManager();
    this.compoundEngine = new CompoundEngine();
    this.telegramBot = new TelegramBot(this);

    // Main loop interval (30 seconds)
    this.loopInterval = null;
    this.loopMs = parseInt(process.env.LOOP_INTERVAL_MS || '30000');
  }

  async initialize() {
    logger.info('🚀 Initializing Solana LP Agent...');

    try {
      // Load persisted state
      await this.state.load();

      // Initialize modules
      await this.priceMonitor.initialize();
      await this.lpManager.initialize();
      await this.telegramBot.initialize();

      logger.info('✅ All modules initialized');
      this.isRunning = true;
      return true;
    } catch (err) {
      logger.error('❌ Initialization failed:', err);
      throw err;
    }
  }

  async start() {
    await this.initialize();
    logger.info('🔄 Starting main agent loop...');

    // Immediate first run
    await this.tick();

    // Schedule recurring loop
    this.loopInterval = setInterval(async () => {
      try {
        await this.tick();
      } catch (err) {
        logger.error('Loop tick error:', err);
      }
    }, this.loopMs);

    // Compound check every hour
    setInterval(async () => {
      try {
        await this.compoundCheck();
      } catch (err) {
        logger.error('Compound check error:', err);
      }
    }, 60 * 60 * 1000);

    logger.info(`✅ Agent running. Loop interval: ${this.loopMs / 1000}s`);
    await this.telegramBot.sendAlert('🟢 LP Agent started successfully');
  }

  async tick() {
    if (!this.isRunning) return;

    try {
      // 1. Update prices for all pools
      const prices = await this.priceMonitor.fetchAllPrices();
      await this.state.updatePrices(prices);

      // 2. Check risk conditions
      const riskStatus = await this.riskManager.evaluate(prices);
      if (riskStatus.halt) {
        logger.warn('⚠️  Risk halt triggered:', riskStatus.reason);
        await this.telegramBot.sendAlert(`⚠️ Risk halt: ${riskStatus.reason}`);
        return;
      }

      // 3. Check each active position
      const positions = await this.state.getPositions();
      for (const pool of ['HYPE-USDC', 'SOL-USDC']) {
        const poolPrice = prices[pool];
        const poolPositions = positions.filter(p => p.pool === pool);

        // 4. Check if rebalance is needed
        const rebalNeeded = await this.rebalanceEngine.shouldRebalance(pool, poolPrice, poolPositions);
        if (rebalNeeded.rebalance) {
          logger.info(`🔁 Rebalance triggered for ${pool}: ${rebalNeeded.reason}`);
          await this.executeRebalance(pool, poolPrice, rebalNeeded);
        }

        // 5. Update position stats
        await this.updatePositionStats(pool, poolPositions, poolPrice);
      }

      // 6. Save state
      await this.state.save();

    } catch (err) {
      logger.error('Tick error:', err);
    }
  }

  async executeRebalance(pool, currentPrice, rebalInfo) {
    try {
      logger.info(`Executing rebalance for ${pool}...`);

      // Get current strategy config
      const strategy = await this.state.getStrategy(pool);
      const config = this.strategyEngine.buildPositionConfig(pool, currentPrice, strategy);

      // Validate with risk manager
      const riskCheck = await this.riskManager.validateNewPositions(config);
      if (!riskCheck.ok) {
        logger.warn(`Rebalance blocked by risk manager: ${riskCheck.reason}`);
        return;
      }

      // Close old positions
      const oldPositions = await this.state.getPositions(pool);
      for (const pos of oldPositions) {
        await this.lpManager.closePosition(pos);
        logger.info(`Closed position ${pos.id}`);
      }

      // Open new positions
      const newPositions = await this.lpManager.openPositions(config);
      await this.state.setPositions(pool, newPositions);

      logger.info(`✅ Rebalance complete for ${pool}. ${newPositions.length} positions opened.`);
      await this.telegramBot.sendAlert(
        `🔁 Rebalanced ${pool}\n` +
        `Price: $${currentPrice.toFixed(4)}\n` +
        `Positions: ${newPositions.length}\n` +
        `Reason: ${rebalInfo.reason}`
      );
    } catch (err) {
      logger.error(`Rebalance failed for ${pool}:`, err);
      await this.telegramBot.sendAlert(`❌ Rebalance failed for ${pool}: ${err.message}`);
    }
  }

  async updatePositionStats(pool, positions, currentPrice) {
    for (const pos of positions) {
      const inRange = currentPrice >= pos.lowerPrice && currentPrice <= pos.upperPrice;
      const fees = await this.lpManager.getAccruedFees(pos);
      await this.state.updatePositionStats(pos.id, { inRange, fees, currentPrice });
    }
  }

  async compoundCheck() {
    const mode = await this.state.getCompoundMode();
    if (mode === 'off') return;

    for (const pool of ['HYPE-USDC', 'SOL-USDC']) {
      const positions = await this.state.getPositions(pool);
      for (const pos of positions) {
        const fees = await this.lpManager.getAccruedFees(pos);
        if (fees.totalUSD > parseFloat(process.env.MIN_COMPOUND_USD || '10')) {
          await this.compoundEngine.compound(pos, fees, mode);
        }
      }
    }
  }

  async stop() {
    logger.info('🛑 Stopping LP Agent...');
    this.isRunning = false;
    if (this.loopInterval) clearInterval(this.loopInterval);
    await this.state.save();
    await this.telegramBot.sendAlert('🔴 LP Agent stopped');
    logger.info('Agent stopped.');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      state: this.state.getSummary(),
    };
  }
}

// --- Bootstrap ---
const agent = new LPAgent();

process.on('SIGINT', async () => {
  logger.info('SIGINT received');
  await agent.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received');
  await agent.stop();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});

agent.start().catch(err => {
  logger.error('Fatal start error:', err);
  process.exit(1);
});

module.exports = agent;
