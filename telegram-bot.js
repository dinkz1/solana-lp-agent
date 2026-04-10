/**
 * TelegramBot - Agent control interface
 *
 * Commands:
 *   /start    - Initialize agent
 *   /status   - Live status dashboard
 *   /strategy - Switch LP strategy
 *   /rebalance - Force rebalance
 *   /compound  - Trigger manual compounding
 *   /stop      - Stop agent
 *   /positions - Detailed LP breakdown
 *   /apr       - Current APR estimates
 *   /risk      - Risk manager status
 *   /help      - Command reference
 */

const TelegramBotAPI = require('node-telegram-bot-api');
const logger = require('./logger');

class TelegramBot {
  constructor(agent) {
    this.agent = agent;
    this.bot = null;
    this.chatIds = new Set();
    this.allowedUsers = (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').filter(Boolean).map(Number);
  }

  async initialize() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.warn('TELEGRAM_BOT_TOKEN not set — Telegram bot disabled');
      return;
    }

    this.bot = new TelegramBotAPI(token, { polling: true });
    this._registerHandlers();
    logger.info('Telegram bot initialized');
  }

  _registerHandlers() {
    this.bot.on('message', async (msg) => {
      const chatId = msg.chat.id;
      const userId = msg.from?.id;

      // Auth check
      if (this.allowedUsers.length && !this.allowedUsers.includes(userId)) {
        this.bot.sendMessage(chatId, '❌ Unauthorized');
        logger.warn(`Unauthorized access attempt from user ${userId}`);
        return;
      }

      this.chatIds.add(chatId);
      const text = msg.text?.trim();
      if (!text || !text.startsWith('/')) return;

      const [cmd, ...args] = text.split(' ');

      try {
        await this._handleCommand(chatId, cmd.toLowerCase(), args);
      } catch (err) {
        logger.error('Telegram command error:', err);
        this.bot.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    });

    this.bot.on('polling_error', (err) => {
      logger.error('Telegram polling error:', err.message);
    });
  }

  async _handleCommand(chatId, cmd, args) {
    switch (cmd) {
      case '/start':      return this._cmdStart(chatId);
      case '/status':     return this._cmdStatus(chatId);
      case '/strategy':   return this._cmdStrategy(chatId, args);
      case '/rebalance':  return this._cmdRebalance(chatId, args);
      case '/compound':   return this._cmdCompound(chatId, args);
      case '/stop':       return this._cmdStop(chatId);
      case '/positions':  return this._cmdPositions(chatId);
      case '/apr':        return this._cmdAPR(chatId);
      case '/risk':       return this._cmdRisk(chatId);
      case '/help':       return this._cmdHelp(chatId);
      default:
        this.bot.sendMessage(chatId, '❓ Unknown command. Use /help');
    }
  }

  // ── /start ─────────────────────────────────────────────────────────────
  async _cmdStart(chatId) {
    this.bot.sendMessage(chatId, [
      '🤖 *Solana LP Agent*',
      '',
      '✅ Agent is running',
      `📡 Monitoring: SOL-USDC | HYPE-USDC`,
      '',
      'Use /status for live stats',
      'Use /help for all commands',
    ].join('\n'), { parse_mode: 'Markdown' });
  }

  // ── /status ────────────────────────────────────────────────────────────
  async _cmdStatus(chatId) {
    const state = this.agent.state.getSummary();
    const prices = state.prices;
    const positions = state.positions;

    const totalCapital = positions.reduce((s, p) => s + parseFloat(p.capitalUSD || 0), 0);
    const totalFees = positions.reduce((s, p) => s + parseFloat(p.feesEarnedUSD || 0), 0);
    const inRangeCount = positions.filter(p => p.inRange).length;

    // Per-pool earnings
    const earnings = state.earnings;
    const solEarnings = earnings?.['SOL-USDC']?.totalUSD?.toFixed(2) || '0.00';
    const hypeEarnings = earnings?.['HYPE-USDC']?.totalUSD?.toFixed(2) || '0.00';

    const lines = [
      '📊 *LP Agent Status*',
      `⏱️  Uptime: ${state.uptimeHrs}h`,
      '',
      '💲 *Prices*',
      `  SOL:  $${prices?.['SOL-USDC']?.toFixed(2) || 'N/A'}`,
      `  HYPE: $${prices?.['HYPE-USDC']?.toFixed(4) || 'N/A'}`,
      '',
      '📍 *Positions*',
      `  Active: ${positions.length}`,
      `  In-range: ${inRangeCount}/${positions.length}`,
      `  Total Capital: $${totalCapital.toFixed(2)}`,
      '',
      '💰 *Earnings*',
      `  SOL-USDC: $${solEarnings}`,
      `  HYPE-USDC: $${hypeEarnings}`,
      `  Total: $${totalFees.toFixed(4)}`,
      '',
      '🔁 *Rebalances*: ' + (state.rebalanceCount || 0),
      '⚙️  Mode: ' + (state.compoundMode || 'balanced'),
    ];

    this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  // ── /strategy ──────────────────────────────────────────────────────────
  async _cmdStrategy(chatId, args) {
    // /strategy SOL-USDC 3-position
    if (args.length < 2) {
      return this.bot.sendMessage(chatId, [
        '⚙️  *Strategy Command*',
        'Usage: `/strategy [pool] [mode]`',
        '',
        'Pools: `SOL-USDC` | `HYPE-USDC`',
        'Modes: `2-position` | `3-position`',
        '',
        'Example: `/strategy SOL-USDC 3-position`',
      ].join('\n'), { parse_mode: 'Markdown' });
    }

    const [pool, mode] = args;
    if (!['SOL-USDC', 'HYPE-USDC'].includes(pool)) {
      return this.bot.sendMessage(chatId, '❌ Invalid pool. Use SOL-USDC or HYPE-USDC');
    }
    if (!['2-position', '3-position'].includes(mode)) {
      return this.bot.sendMessage(chatId, '❌ Invalid mode. Use 2-position or 3-position');
    }

    await this.agent.state.setStrategy(pool, mode);
    this.bot.sendMessage(chatId, `✅ Strategy for *${pool}* set to *${mode}*\n\nWill apply on next rebalance.`, { parse_mode: 'Markdown' });
  }

  // ── /rebalance ─────────────────────────────────────────────────────────
  async _cmdRebalance(chatId, args) {
    const pool = args[0];
    const pools = pool ? [pool] : ['SOL-USDC', 'HYPE-USDC'];

    this.bot.sendMessage(chatId, `🔁 Forcing rebalance for: ${pools.join(', ')}...`);

    for (const p of pools) {
      if (!['SOL-USDC', 'HYPE-USDC'].includes(p)) {
        this.bot.sendMessage(chatId, `❌ Unknown pool: ${p}`);
        continue;
      }
      const price = this.agent.priceMonitor.getPrice(p);
      if (!price) {
        this.bot.sendMessage(chatId, `❌ No price data for ${p}`);
        continue;
      }

      // Clear cooldown so force rebalance works
      this.agent.rebalanceEngine.lastRebalance[p] = 0;
      await this.agent.executeRebalance(p, price, { reason: 'manual-telegram' });
    }
  }

  // ── /compound ──────────────────────────────────────────────────────────
  async _cmdCompound(chatId, args) {
    const mode = args[0] || null;

    if (mode && !['balanced', 'aggressive', 'conservative', 'off'].includes(mode)) {
      return this.bot.sendMessage(chatId, '❌ Invalid mode. Use: balanced | aggressive | conservative | off');
    }

    if (mode) {
      await this.agent.state.setCompoundMode(mode);
      this.bot.sendMessage(chatId, `✅ Compound mode set to *${mode}*`, { parse_mode: 'Markdown' });
    } else {
      this.bot.sendMessage(chatId, '💰 Running manual compound...');
      await this.agent.compoundCheck();
      this.bot.sendMessage(chatId, '✅ Compounding complete');
    }
  }

  // ── /stop ──────────────────────────────────────────────────────────────
  async _cmdStop(chatId) {
    this.bot.sendMessage(chatId, '🛑 Stopping agent... Positions will remain open.');
    await this.agent.stop();
  }

  // ── /positions ─────────────────────────────────────────────────────────
  async _cmdPositions(chatId) {
    const positions = await this.agent.state.getPositions();

    if (positions.length === 0) {
      return this.bot.sendMessage(chatId, '📭 No active positions');
    }

    const lines = ['📋 *Active Positions*', ''];

    for (const pos of positions) {
      const status = pos.inRange ? '🟢 In-Range' : '🔴 Out-of-Range';
      const hoursOpen = ((Date.now() - pos.openedAt) / 3600000).toFixed(1);
      const hourlyRate = pos.feesEarnedUSD && hoursOpen > 0
        ? (pos.feesEarnedUSD / hoursOpen).toFixed(4)
        : '0.0000';

      lines.push([
        `*${pos.pool}* — ${pos.name.toUpperCase()} | ${status}`,
        `  Range: $${parseFloat(pos.lowerPrice).toFixed(4)} – $${parseFloat(pos.upperPrice).toFixed(4)}`,
        `  Capital: $${parseFloat(pos.capitalUSD).toFixed(2)}`,
        `  Fees: $${parseFloat(pos.feesEarnedUSD || 0).toFixed(4)} ($${hourlyRate}/hr)`,
        `  Open: ${hoursOpen}h`,
        `  ID: \`${pos.id?.substring(0,12)}...\``,
        '',
      ].join('\n'));
    }

    this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  // ── /apr ───────────────────────────────────────────────────────────────
  async _cmdAPR(chatId) {
    const positions = await this.agent.state.getPositions();
    const lines = ['📈 *APR Estimates*', ''];

    for (const pool of ['SOL-USDC', 'HYPE-USDC']) {
      const price = this.agent.priceMonitor.getPrice(pool);
      const strategy = await this.agent.state.getStrategy(pool);
      const vol = this.agent.priceMonitor.getVolatility(pool);

      this.agent.strategyEngine.setVolatility(pool, vol);
      const config = this.agent.strategyEngine.buildPositionConfig(pool, price || 1, strategy);
      const apr = config.estimatedAPR;

      lines.push([
        `*${pool}*`,
        `  Strategy: ${strategy}`,
        `  Volatility: ${vol.toFixed(3)}%`,
        `  Est. Daily: ${apr.dailyFeesPct}%`,
        `  Est. Annual: ${apr.annualAPR}%`,
        `  Feasible: ${apr.feasible ? '✅' : '❌'}`,
        '',
      ].join('\n'));
    }

    this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  // ── /risk ──────────────────────────────────────────────────────────────
  async _cmdRisk(chatId) {
    const status = this.agent.riskManager.getStatus();
    const rebalStatus = this.agent.rebalanceEngine.getStatus();

    const lines = [
      '🔒 *Risk Manager Status*',
      '',
      `Halt Active: ${status.haltActive ? '🔴 YES' : '🟢 No'}`,
      status.haltReason ? `Halt Reason: ${status.haltReason}` : '',
      '',
      '*Cooldowns:*',
      ...Object.entries(rebalStatus.cooldowns || {}).map(([pool, cd]) =>
        `  ${pool}: ${cd.cooldownRemaining > 0 ? (cd.cooldownRemaining/60000).toFixed(1)+'min remaining' : '✅ Ready'}`
      ),
      '',
      `*USDC Reserve*: ${(status.config.minUSDCReservePct * 100).toFixed(0)}% min`,
      `*Max Vol Halt*: ${status.config.maxVolatilityPct}%`,
    ].filter(Boolean);

    this.bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  // ── /help ──────────────────────────────────────────────────────────────
  async _cmdHelp(chatId) {
    this.bot.sendMessage(chatId, [
      '📖 *LP Agent Commands*',
      '',
      '/start — Initialize agent',
      '/status — Live status overview',
      '/positions — Detailed LP breakdown',
      '/apr — Estimated APR per pool',
      '/risk — Risk manager status',
      '',
      '/strategy [pool] [mode] — Switch strategy',
      '  e.g. /strategy SOL-USDC 3-position',
      '',
      '/rebalance [pool?] — Force rebalance',
      '  e.g. /rebalance SOL-USDC',
      '',
      '/compound [mode?] — Set compound mode or trigger now',
      '  Modes: balanced | aggressive | conservative | off',
      '',
      '/stop — Stop agent (positions stay open)',
      '/help — This message',
    ].join('\n'), { parse_mode: 'Markdown' });
  }

  // ── Alert broadcast ────────────────────────────────────────────────────
  async sendAlert(message) {
    if (!this.bot) return;

    // If no known chatIds, load from env
    if (this.chatIds.size === 0) {
      const envChatId = process.env.TELEGRAM_CHAT_ID;
      if (envChatId) this.chatIds.add(parseInt(envChatId));
    }

    for (const chatId of this.chatIds) {
      try {
        await this.bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch (err) {
        logger.debug(`Alert send error to ${chatId}: ${err.message}`);
      }
    }
  }
}

module.exports = TelegramBot;
