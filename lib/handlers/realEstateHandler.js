const { BaseHandler } = require('./baseHandler');

class RealEstateHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'real_estate';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting real estate scraping task', { taskConfig });

        try {
            // Check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached real estate data');
                return cachedData;
            }

            // Initialize scraping based on configuration
            const result = await this.scrapeWithPlaywright(taskConfig);

            // Enrich data with additional information
            const enrichedData = await this.enrichPropertyData(result, taskConfig);

            // Cache the results
            await this.cacheSet(cacheKey, enrichedData, this.getCacheTTL(taskConfig));

            return enrichedData;
        } catch (error) {
            this.logger.error('Real estate scraping failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    async scrapeWithPlaywright(taskConfig) {
        return this.withPage(async (page) => {
            // Set up geolocation if provided
            if (taskConfig.location) {
                await this.setGeolocation(page, taskConfig.location);
            }

            // Configure request interception
            await this.setupRealEstateInterception(page);

            // Navigate to the property page
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle location consent if needed
            await this.handleLocationConsent(page);

            // Wait for map and property elements
            await this.waitForPropertyElements(page, taskConfig);

            // Extract property data including map information
            const propertyData = await this.extractPropertyData(page, taskConfig);

            // Get additional data if needed
            if (taskConfig.includeNearbyAmenities) {
                propertyData.amenities = await this.extractNearbyAmenities(page, taskConfig);
            }

            if (taskConfig.includePriceHistory) {
                propertyData.priceHistory = await this.extractPriceHistory(page, taskConfig);
            }

            return propertyData;
        });
    }

    async setGeolocation(page, location) {
        await page.setGeolocation({
            latitude: location.latitude,
            longitude: location.longitude,
            accuracy: location.accuracy || 100
        });

        // Grant geolocation permissions
        await page.context().grantPermissions(['geolocation']);
    }

    async setupRealEstateInterception(page) {
        await page.route('**/*', (route) => {
            const request = route.request();
            if (this.shouldBlockRealEstateResource(request)) {
                return route.abort();
            }
            return route.continue();
        });

        // Monitor for map tile requests
        page.on('response', async (response) => {
            if (this.isMapTileResponse(response)) {
                await this.handleMapTileResponse(response);
            }
        });
    }

    shouldBlockRealEstateResource(request) {
        const blockedTypes = ['font', 'media'];
        const criticalTypes = ['document', 'script', 'xhr', 'fetch', 'image'];

        if (criticalTypes.includes(request.resourceType())) {
            return false;
        }

        if (blockedTypes.includes(request.resourceType())) {
            return true;
        }

        // Allow map-related resources
        if (this.isMapResource(request.url())) {
            return false;
        }

        return request.resourceType() === 'image' && !this.isPropertyImage(request.url());
    }

    isMapResource(url) {
        const mapProviders = [
            'google.com/maps',
            'api.mapbox.com',
            'tile.openstreetmap.org',
            'maps.googleapis.com'
        ];
        return mapProviders.some(provider => url.includes(provider));
    }

    isPropertyImage(url) {
        const imagePatterns = [
            '/property/',
            '/photos/',
            '/images/',
            '/listing/'
        ];
        return imagePatterns.some(pattern => url.includes(pattern));
    }

    async handleLocationConsent(page) {
        const consentSelectors = [
            '[aria-label*="location"] button',
            '[data-testid*="location-prompt"] button',
            'button:has-text("Allow location")'
        ];

        for (const selector of consentSelectors) {
            try {
                await page.click(selector);
                break;
            } catch (error) {
                continue;
            }
        }
    }

    async waitForPropertyElements(page, taskConfig) {
        const selectors = taskConfig.selectors || this.getDefaultSelectors();
        await Promise.all([
            page.waitForSelector(selectors.price),
            page.waitForSelector(selectors.details),
            page.waitForSelector(selectors.map)
        ].filter(Boolean));
    }

    getDefaultSelectors() {
        return {
            price: '.property-price, [data-testid="price"]',
            details: '.property-details, [data-testid="details"]',
            map: '#propertyMap, .map-container',
            images: '.property-images img',
            amenities: '.nearby-amenities',
            priceHistory: '.price-history',
            features: '.property-features',
            agent: '.agent-info'
        };
    }

    async extractPropertyData(page, taskConfig) {
        const selectors = taskConfig.selectors || this.getDefaultSelectors();

        const basicInfo = await page.evaluate((selectors) => {
            const getTextContent = (selector) => {
                const element = document.querySelector(selector);
                return element ? element.textContent.trim() : null;
            };

            const getImages = (selector) => {
                return Array.from(document.querySelectorAll(selector))
                    .map(img => ({
                        url: img.src,
                        alt: img.alt,
                        type: img.dataset.type || 'property'
                    }))
                    .filter(img => img.url);
            };

            return {
                price: getTextContent(selectors.price),
                details: this.extractPropertyDetails(selectors.details),
                images: getImages(selectors.images),
                features: this.extractFeatures(selectors.features),
                agent: this.extractAgentInfo(selectors.agent),
                url: window.location.href,
                timestamp: new Date().toISOString()
            };
        }, selectors);

        // Extract map data
        const mapData = await this.extractMapData(page, taskConfig);

        return {
            ...basicInfo,
            location: mapData
        };
    }

    async extractMapData(page, taskConfig) {
        // Extract map coordinates and boundaries
        const mapData = await page.evaluate((selector) => {
            const mapElement = document.querySelector(selector);
            if (!mapElement) return null;

            // Extract data based on common map providers
            if (window.google && window.google.maps) {
                return this.extractGoogleMapData(mapElement);
            }

            if (window.mapboxgl) {
                return this.extractMapboxData(mapElement);
            }

            // Fallback to data attributes
            return {
                latitude: mapElement.dataset.latitude,
                longitude: mapElement.dataset.longitude,
                zoom: mapElement.dataset.zoom
            };
        }, taskConfig.selectors.map);

        return mapData;
    }

    async extractNearbyAmenities(page, taskConfig) {
        const amenities = await page.evaluate((selector) => {
            const categories = {
                transportation: [],
                education: [],
                shopping: [],
                restaurants: [],
                healthcare: [],
                recreation: []
            };

            document.querySelectorAll(selector).forEach(item => {
                const category = item.dataset.category;
                if (category && categories[category]) {
                    categories[category].push({
                        name: item.textContent,
                        distance: item.dataset.distance,
                        rating: item.dataset.rating
                    });
                }
            });

            return categories;
        }, taskConfig.selectors.amenities);

        // Enrich with additional data from external sources
        return this.enrichAmenitiesData(amenities);
    }

    async extractPriceHistory(page, taskConfig) {
        return page.evaluate((selector) => {
            const history = [];
            document.querySelectorAll(selector).forEach(item => {
                history.push({
                    date: item.dataset.date,
                    price: item.dataset.price,
                    event: item.dataset.event,
                    source: item.dataset.source
                });
            });
            return history;
        }, taskConfig.selectors.priceHistory);
    }

    async enrichPropertyData(data, taskConfig) {
        try {
            // Use Gemini API for advanced analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzePropertyWithGemini(data, apiKey);

            // Add market analysis
            const marketData = await this.getMarketAnalysis(data.location);

            return {
                ...data,
                analysis: enrichedData,
                market: marketData
            };
        } catch (error) {
            this.logger.error('Property data enrichment failed:', error);
            return data;
        }
    }

    async analyzePropertyWithGemini(data, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this property listing and provide insights on:
            1. Price comparison with market average
            2. Investment potential
            3. Notable features and their impact on value
            4. Location analysis
            5. Potential concerns or red flags
            6. Future value projection
            7. Target buyer demographic
            8. Negotiation recommendations

            Property Data:
            ${JSON.stringify(data, null, 2)}
        `;

        try {
            const result = await model.generateContent(prompt);
            const response = await result.response;
            return JSON.parse(response.text());
        } catch (error) {
            this.logger.error('Gemini API analysis failed:', error);
            return {};
        }
    }

    async getMarketAnalysis(location) {
        // Implement market analysis logic
        // This could include:
        // - Historical price trends
        // - Market comparables
        // - Economic indicators
        // - Development plans
        return {};
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: taskConfig.type || 'property',
            location: taskConfig.location,
            timestamp: Math.floor(Date.now() / (1000 * 3600)) // 1-hour buckets
        };
        return JSON.stringify(key);
    }

    getCacheTTL(taskConfig) {
        // Different TTLs based on data type
        const ttls = {
            property: 3600, // 1 hour for basic property info
            prices: 1800,   // 30 minutes for prices
            market: 7200,   // 2 hours for market data
            amenities: 86400 // 24 hours for amenities
        };
        return ttls[taskConfig.type] || ttls.property;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative data sources
        const providers = [
            this.scrapeWithApify,
            this.scrapeWithSerpApi,
            this.scrapeWithGooseCSE
        ];

        for (const provider of providers) {
            try {
                const result = await provider.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to get property data from all sources');
    }
}

module.exports = { RealEstateHandler };
