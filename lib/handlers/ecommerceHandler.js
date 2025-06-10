const { BaseHandler } = require('./baseHandler');
const cheerio = require('cheerio');

class EcommerceHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'ecommerce';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting ecommerce scraping task', { taskConfig });

        try {
            // Check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached ecommerce data');
                return cachedData;
            }

            // Determine the best tool based on the target site
            const result = await this.scrapeWithOptimalTool(taskConfig);

            // Cache the results with appropriate TTL based on data type
            await this.cacheSet(cacheKey, result, this.getCacheTTL(taskConfig));

            return result;
        } catch (error) {
            this.logger.error('Ecommerce scraping failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    async scrapeWithOptimalTool(taskConfig) {
        // Check if the site requires JavaScript
        if (await this.requiresJavaScript(taskConfig.url)) {
            return this.scrapeWithPlaywright(taskConfig);
        }
        
        // Try Cheerio first for better performance
        try {
            return await this.scrapeWithCheerio(taskConfig);
        } catch (error) {
            if (this.shouldFallbackToPlaywright(error)) {
                this.logger.info('Falling back to Playwright');
                return this.scrapeWithPlaywright(taskConfig);
            }
            throw error;
        }
    }

    async requiresJavaScript(url) {
        // List of known JS-heavy ecommerce platforms
        const jsRequiredDomains = [
            'shopify.com',
            'amazon.com',
            'walmart.com',
            'target.com'
        ];
        return jsRequiredDomains.some(domain => url.includes(domain));
    }

    shouldFallbackToPlaywright(error) {
        const fallbackTriggers = [
            'failed to load',
            'content not found',
            'empty response',
            'cloudflare'
        ];
        return fallbackTriggers.some(trigger => 
            error.message.toLowerCase().includes(trigger)
        );
    }

    async scrapeWithCheerio(taskConfig) {
        const response = await fetch(taskConfig.url, {
            headers: {
                'User-Agent': await this.getRandomUserAgent(),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const html = await response.text();
        const $ = cheerio.load(html);

        return this.extractProductData($, taskConfig);
    }

    async scrapeWithPlaywright(taskConfig) {
        return this.withPage(async (page) => {
            // Set up request interception for performance
            await this.setupEcommerceInterception(page);

            // Navigate to the product page
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle cookie consent if present
            await this.handleCookieConsent(page);

            // Wait for critical elements
            await this.waitForProductElements(page, taskConfig);

            // Extract product data
            const productData = await this.extractProductDataFromPage(page, taskConfig);

            // Get additional data if needed
            if (taskConfig.includeReviews) {
                productData.reviews = await this.extractReviews(page, taskConfig);
            }

            if (taskConfig.includeVariants) {
                productData.variants = await this.extractVariants(page, taskConfig);
            }

            return productData;
        });
    }

    async setupEcommerceInterception(page) {
        await page.route('**/*', (route) => {
            const request = route.request();
            if (this.shouldBlockEcommerceResource(request)) {
                return route.abort();
            }
            return route.continue();
        });

        // Monitor for dynamic price updates
        page.on('response', async (response) => {
            if (this.isPriceUpdateResponse(response)) {
                this.handlePriceUpdate(response);
            }
        });
    }

    shouldBlockEcommerceResource(request) {
        const blockedTypes = ['image', 'media', 'font'];
        const allowedTypes = ['xhr', 'fetch', 'document', 'script'];

        // Allow resources needed for proper functionality
        if (allowedTypes.includes(request.resourceType())) {
            return false;
        }

        // Block non-essential resources
        if (blockedTypes.includes(request.resourceType())) {
            return true;
        }

        // Allow critical CSS, block non-critical
        if (request.resourceType() === 'stylesheet') {
            return !this.isCriticalCSS(request.url());
        }

        return false;
    }

    isCriticalCSS(url) {
        const criticalPatterns = [
            'critical',
            'main',
            'product',
            'essential'
        ];
        return criticalPatterns.some(pattern => url.includes(pattern));
    }

    isPriceUpdateResponse(response) {
        const url = response.url();
        const pricePatterns = [
            'price',
            'inventory',
            'stock',
            'availability'
        ];
        return pricePatterns.some(pattern => url.includes(pattern));
    }

    async handlePriceUpdate(response) {
        try {
            const data = await response.json();
            this.logger.debug('Price update detected:', data);
            // Handle real-time price updates
        } catch (error) {
            this.logger.error('Failed to process price update:', error);
        }
    }

    async handleCookieConsent(page) {
        const commonSelectors = [
            '[id*="cookie"] button[type="submit"]',
            '[class*="cookie"] button',
            '[id*="consent"] button',
            'button[aria-label*="Accept"]'
        ];

        for (const selector of commonSelectors) {
            try {
                const button = await page.$(selector);
                if (button) {
                    await button.click();
                    break;
                }
            } catch (error) {
                continue;
            }
        }
    }

    async waitForProductElements(page, taskConfig) {
        const selectors = taskConfig.selectors || this.getDefaultSelectors();
        await Promise.race([
            page.waitForSelector(selectors.price),
            page.waitForSelector(selectors.title),
            page.waitForSelector(selectors.availability)
        ]);
    }

    getDefaultSelectors() {
        return {
            title: 'h1, .product-title, .product-name',
            price: '.price, [data-price], .product-price',
            availability: '[data-availability], .stock-status',
            description: '.description, .product-description',
            images: '.product-image img, .gallery img',
            variants: '.variants select, .variant-options',
            reviews: '.reviews, #reviews, .ratings'
        };
    }

    async extractProductDataFromPage(page, taskConfig) {
        const selectors = taskConfig.selectors || this.getDefaultSelectors();

        return await page.evaluate((selectors) => {
            const getTextContent = (selector) => {
                const element = document.querySelector(selector);
                return element ? element.textContent.trim() : null;
            };

            const getImages = (selector) => {
                return Array.from(document.querySelectorAll(selector))
                    .map(img => img.src)
                    .filter(Boolean);
            };

            return {
                title: getTextContent(selectors.title),
                price: this.extractPrice(selectors.price),
                availability: getTextContent(selectors.availability),
                description: getTextContent(selectors.description),
                images: getImages(selectors.images),
                url: window.location.href,
                timestamp: new Date().toISOString()
            };
        }, selectors);
    }

    async extractReviews(page, taskConfig) {
        // Implementation depends on site structure
        // This is a basic example
        return page.evaluate((selector) => {
            const reviews = [];
            document.querySelectorAll(selector).forEach(review => {
                reviews.push({
                    rating: review.querySelector('.rating')?.textContent,
                    text: review.querySelector('.text')?.textContent,
                    author: review.querySelector('.author')?.textContent,
                    date: review.querySelector('.date')?.textContent
                });
            });
            return reviews;
        }, taskConfig.selectors.reviews);
    }

    async extractVariants(page, taskConfig) {
        return page.evaluate((selector) => {
            const variants = [];
            document.querySelectorAll(selector).forEach(variant => {
                variants.push({
                    name: variant.getAttribute('data-name'),
                    value: variant.getAttribute('data-value'),
                    price: variant.getAttribute('data-price'),
                    available: variant.getAttribute('data-available') === 'true'
                });
            });
            return variants;
        }, taskConfig.selectors.variants);
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: taskConfig.type || 'product',
            includeReviews: !!taskConfig.includeReviews,
            includeVariants: !!taskConfig.includeVariants,
            timestamp: Math.floor(Date.now() / (1000 * 60)) // 1-minute buckets for prices
        };
        return JSON.stringify(key);
    }

    getCacheTTL(taskConfig) {
        // Different TTLs based on data type
        const ttls = {
            price: 60, // 1 minute for prices
            inventory: 300, // 5 minutes for inventory
            reviews: 3600, // 1 hour for reviews
            product: 86400 // 24 hours for basic product info
        };
        return ttls[taskConfig.type] || ttls.product;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative data sources
        if (taskConfig.type === 'price') {
            return this.getPriceFromAlternativeSources(taskConfig);
        }

        // Use Apify as last resort
        return this.scrapeWithApify(taskConfig);
    }

    async getPriceFromAlternativeSources(taskConfig) {
        // Try price API providers
        const providers = [
            this.tryPriceAPI,
            this.trySerpAPI,
            this.tryGooseCSE
        ];

        for (const provider of providers) {
            try {
                const result = await provider.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to get price from all sources');
    }

    async scrapeWithApify(taskConfig) {
        const apifyClient = require('apify-client');
        const client = new apifyClient.ApifyClient({
            token: await this.getApiKey('apify')
        });

        const run = await client.actor('ecommerce-scraper').call({
            url: taskConfig.url,
            ...taskConfig
        });

        return await run.dataset().getData();
    }
}

module.exports = { EcommerceHandler };
