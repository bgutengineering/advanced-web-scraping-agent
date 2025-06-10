const playwright = require('playwright');
const cheerio = require('cheerio');
const { Logger } = require('../utils/logger');

class BaseHandler {
    constructor(options) {
        this.config = options.config;
        this.apiKeyManager = options.apiKeyManager;
        this.proxyManager = options.proxyManager;
        this.cacheManager = options.cacheManager;
        this.logger = new Logger();
        this.browser = null;
        this.context = null;
    }

    async execute(taskConfig) {
        throw new Error('execute() method must be implemented by handler');
    }

    async initializeBrowser(useProxy = true) {
        try {
            let proxy = null;
            if (useProxy && this.proxyManager) {
                proxy = await this.proxyManager.getProxy(this.constructor.name);
            }

            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920,1080'
                ]
            };

            if (proxy) {
                launchOptions.proxy = {
                    server: proxy
                };
            }

            this.browser = await playwright.chromium.launch(launchOptions);
            this.context = await this.browser.newContext({
                viewport: { width: 1920, height: 1080 },
                userAgent: await this.getRandomUserAgent()
            });

            // Set default timeout
            this.context.setDefaultTimeout(30000);

            return this.context;
        } catch (error) {
            this.logger.error('Failed to initialize browser:', error);
            throw error;
        }
    }

    async closeBrowser() {
        if (this.context) {
            await this.context.close();
            this.context = null;
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    async getRandomUserAgent() {
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59'
        ];
        return userAgents[Math.floor(Math.random() * userAgents.length)];
    }

    async withBrowser(callback, useProxy = true) {
        try {
            await this.initializeBrowser(useProxy);
            return await callback(this.context);
        } finally {
            await this.closeBrowser();
        }
    }

    async withPage(callback, useProxy = true) {
        return this.withBrowser(async (context) => {
            const page = await context.newPage();
            try {
                return await callback(page);
            } finally {
                await page.close();
            }
        }, useProxy);
    }

    async handlePlaywright(url, options = {}) {
        return this.withPage(async (page) => {
            await this.setupPageInterception(page, options);
            await page.goto(url, { waitUntil: 'networkidle' });
            
            if (options.waitForSelector) {
                await page.waitForSelector(options.waitForSelector);
            }

            if (options.scrollToBottom) {
                await this.autoScroll(page);
            }

            return await options.extractData(page);
        }, options.useProxy);
    }

    async setupPageInterception(page, options) {
        // Block unnecessary resources to improve performance
        if (options.blockResources) {
            await page.route('**/*', (route) => {
                const resourceType = route.request().resourceType();
                const blockedTypes = ['image', 'stylesheet', 'font', 'media'];
                
                if (blockedTypes.includes(resourceType)) {
                    return route.abort();
                }
                return route.continue();
            });
        }

        // Handle authentication if needed
        if (options.authentication) {
            await page.authenticate(options.authentication);
        }
    }

    async autoScroll(page) {
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
    }

    async handleCheerio(url, options = {}) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': await this.getRandomUserAgent()
                },
                ...options
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const html = await response.text();
            const $ = cheerio.load(html);
            return await options.extractData($);
        } catch (error) {
            this.logger.error('Cheerio scraping failed:', error);
            throw error;
        }
    }

    async getApiKey(provider) {
        return await this.apiKeyManager.getKey(provider);
    }

    async cacheGet(key) {
        if (!this.cacheManager) return null;
        return await this.cacheManager.get(this.constructor.name, key);
    }

    async cacheSet(key, value, ttl = null) {
        if (!this.cacheManager) return false;
        return await this.cacheManager.set(this.constructor.name, key, value, ttl);
    }

    async handleError(error, context = {}) {
        this.logger.error('Handler error:', error, context);

        // Check if error is related to proxy
        if (this.isProxyError(error) && context.proxy) {
            await this.proxyManager.markProxyError(context.proxy, error);
        }

        // Check if error is related to API key
        if (this.isApiKeyError(error) && context.apiKey) {
            await this.apiKeyManager.markKeyError(context.provider, context.apiKey, error);
        }

        throw error;
    }

    isProxyError(error) {
        const proxyErrorMessages = [
            'ECONNREFUSED',
            'ECONNRESET',
            'ETIMEDOUT',
            'PROXY_CONNECTION_FAILED'
        ];
        return proxyErrorMessages.some(msg => error.message.includes(msg));
    }

    isApiKeyError(error) {
        const apiKeyErrorMessages = [
            'rate limit exceeded',
            'invalid api key',
            'unauthorized',
            'forbidden'
        ];
        return apiKeyErrorMessages.some(msg => 
            error.message.toLowerCase().includes(msg)
        );
    }

    validateConfig(config, requiredFields) {
        for (const field of requiredFields) {
            if (!(field in config)) {
                throw new Error(`Missing required field: ${field}`);
            }
        }
    }
}

module.exports = { BaseHandler };
