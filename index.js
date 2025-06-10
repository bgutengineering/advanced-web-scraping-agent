#!/usr/bin/env node

const { loadConfig } = require('./lib/config');
const { ApiKeyManager } = require('./lib/managers/apiKeyManager');
const { ProxyManager } = require('./lib/managers/proxyManager');
const { TaskScheduler } = require('./lib/scheduler');
const { CacheManager } = require('./lib/managers/cacheManager');
const { Logger } = require('./lib/utils/logger');

class WebScrapingAgent {
    constructor() {
        this.logger = new Logger();
        this.config = null;
        this.apiKeyManager = null;
        this.proxyManager = null;
        this.scheduler = null;
        this.cacheManager = null;
    }

    async initialize() {
        try {
            // Load configuration
            this.config = await loadConfig();
            
            // Initialize core systems
            this.apiKeyManager = new ApiKeyManager(this.config.api_keys);
            this.proxyManager = new ProxyManager(this.config.proxies);
            this.cacheManager = new CacheManager(this.config.cache);
            this.scheduler = new TaskScheduler(this.config.scheduler);

            // Initialize category-specific handlers
            await this.initializeCategoryHandlers();

            this.logger.info('Web Scraping Agent initialized successfully');
        } catch (error) {
            this.logger.error('Failed to initialize Web Scraping Agent:', error);
            process.exit(1);
        }
    }

    async initializeCategoryHandlers() {
        // Load all category handlers dynamically
        const categories = Object.keys(this.config.categories);
        this.categoryHandlers = {};

        for (const category of categories) {
            const HandlerClass = require(`./lib/handlers/${category}Handler`);
            this.categoryHandlers[category] = new HandlerClass({
                config: this.config.categories[category],
                apiKeyManager: this.apiKeyManager,
                proxyManager: this.proxyManager,
                cacheManager: this.cacheManager,
                logger: this.logger
            });
        }
    }

    async scheduleTask(category, taskConfig) {
        if (!this.categoryHandlers[category]) {
            throw new Error(`Unknown category: ${category}`);
        }

        return this.scheduler.schedule({
            category,
            config: taskConfig,
            handler: this.categoryHandlers[category],
            priority: taskConfig.priority || 'medium'
        });
    }

    async shutdown() {
        this.logger.info('Shutting down Web Scraping Agent...');
        await this.scheduler.stop();
        await this.cacheManager.close();
        await this.proxyManager.close();
        this.logger.info('Shutdown complete');
    }
}

// Handle process signals for graceful shutdown
process.on('SIGTERM', async () => {
    console.log('Received SIGTERM signal');
    await agent.shutdown();
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('Received SIGINT signal');
    await agent.shutdown();
    process.exit(0);
});

// Create agent instance
const agent = new WebScrapingAgent();

// Export for programmatic usage
module.exports = agent;

// If running as main script
if (require.main === module) {
    agent.initialize().catch(error => {
        console.error('Failed to start Web Scraping Agent:', error);
        process.exit(1);
    });
}
