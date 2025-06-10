const { BaseHandler } = require('./baseHandler');

class TravelHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'travel';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting travel data scraping task', { taskConfig });

        try {
            // For real-time availability, skip cache
            if (taskConfig.checkAvailability) {
                return this.handleRealTimeAvailability(taskConfig);
            }

            // For other data, check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached travel data');
                return cachedData;
            }

            // Determine data type and appropriate handling method
            const dataType = this.determineDataType(taskConfig);
            let result;

            switch (dataType) {
                case 'flights':
                    result = await this.handleFlightData(taskConfig);
                    break;
                case 'hotels':
                    result = await this.handleHotelData(taskConfig);
                    break;
                case 'reviews':
                    result = await this.handleTravelReviews(taskConfig);
                    break;
                case 'destinations':
                    result = await this.handleDestinationData(taskConfig);
                    break;
                default:
                    result = await this.handleGenericTravelData(taskConfig);
            }

            // Enrich with additional data
            const enrichedData = await this.enrichTravelData(result, taskConfig);

            // Cache the results if not real-time
            if (!taskConfig.checkAvailability) {
                await this.cacheSet(cacheKey, enrichedData, this.getCacheTTL(dataType));
            }

            return enrichedData;
        } catch (error) {
            this.logger.error('Travel data processing failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    determineDataType(taskConfig) {
        if (taskConfig.url.match(/flights|airlines|airport/)) {
            return 'flights';
        }
        if (taskConfig.url.match(/hotels|accommodation|rooms/)) {
            return 'hotels';
        }
        if (taskConfig.url.match(/reviews|ratings/)) {
            return 'reviews';
        }
        if (taskConfig.url.match(/destinations|places|attractions/)) {
            return 'destinations';
        }
        return 'generic';
    }

    async handleRealTimeAvailability(taskConfig) {
        return this.withPage(async (page) => {
            // Configure request interception for performance
            await this.setupTravelInterception(page);

            // Navigate to booking site
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Fill in search parameters
            await this.fillSearchForm(page, taskConfig);

            // Wait for results and extract availability
            return await this.extractAvailabilityData(page, taskConfig);
        });
    }

    async handleFlightData(taskConfig) {
        return this.withPage(async (page) => {
            await this.setupTravelInterception(page);
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle cookie consent and popups
            await this.handleTravelSitePopups(page);

            // Extract flight data
            const flightData = await page.evaluate(() => {
                return {
                    flights: Array.from(document.querySelectorAll('.flight-item'))
                        .map(flight => ({
                            airline: flight.querySelector('.airline')?.textContent,
                            flightNumber: flight.querySelector('.flight-number')?.textContent,
                            departure: {
                                time: flight.querySelector('.departure-time')?.textContent,
                                airport: flight.querySelector('.departure-airport')?.textContent
                            },
                            arrival: {
                                time: flight.querySelector('.arrival-time')?.textContent,
                                airport: flight.querySelector('.arrival-airport')?.textContent
                            },
                            duration: flight.querySelector('.duration')?.textContent,
                            price: flight.querySelector('.price')?.textContent,
                            stops: flight.querySelector('.stops')?.textContent,
                            availability: flight.querySelector('.availability')?.textContent
                        }))
                };
            });

            return this.normalizeFlightData(flightData);
        });
    }

    async handleHotelData(taskConfig) {
        return this.withPage(async (page) => {
            await this.setupTravelInterception(page);
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract hotel data
            const hotelData = await page.evaluate(() => {
                return {
                    name: document.querySelector('.hotel-name')?.textContent,
                    address: document.querySelector('.address')?.textContent,
                    rating: document.querySelector('.rating')?.textContent,
                    amenities: Array.from(document.querySelectorAll('.amenity'))
                        .map(amenity => amenity.textContent),
                    rooms: Array.from(document.querySelectorAll('.room-type'))
                        .map(room => ({
                            type: room.querySelector('.type')?.textContent,
                            price: room.querySelector('.price')?.textContent,
                            availability: room.querySelector('.availability')?.textContent,
                            features: Array.from(room.querySelectorAll('.feature'))
                                .map(feature => feature.textContent)
                        })),
                    images: Array.from(document.querySelectorAll('.hotel-image'))
                        .map(img => img.src)
                };
            });

            return this.processHotelData(hotelData);
        });
    }

    async handleTravelReviews(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract review data
            const reviews = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.review'))
                    .map(review => ({
                        author: review.querySelector('.author')?.textContent,
                        date: review.querySelector('.date')?.textContent,
                        rating: review.querySelector('.rating')?.textContent,
                        title: review.querySelector('.title')?.textContent,
                        content: review.querySelector('.content')?.textContent,
                        tripType: review.querySelector('.trip-type')?.textContent,
                        stayDate: review.querySelector('.stay-date')?.textContent,
                        helpful: review.querySelector('.helpful-count')?.textContent
                    }));
            });

            return this.processReviews(reviews);
        });
    }

    async handleDestinationData(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract destination information
            const destinationData = await page.evaluate(() => {
                return {
                    name: document.querySelector('.destination-name')?.textContent,
                    description: document.querySelector('.description')?.textContent,
                    attractions: Array.from(document.querySelectorAll('.attraction'))
                        .map(attraction => ({
                            name: attraction.querySelector('.name')?.textContent,
                            description: attraction.querySelector('.description')?.textContent,
                            rating: attraction.querySelector('.rating')?.textContent,
                            price: attraction.querySelector('.price')?.textContent
                        })),
                    weather: {
                        current: document.querySelector('.weather-current')?.textContent,
                        forecast: document.querySelector('.weather-forecast')?.textContent
                    },
                    transportation: Array.from(document.querySelectorAll('.transport-option'))
                        .map(option => ({
                            type: option.querySelector('.type')?.textContent,
                            details: option.querySelector('.details')?.textContent
                        }))
                };
            });

            return this.processDestinationData(destinationData);
        });
    }

    async enrichTravelData(data, taskConfig) {
        try {
            // Use Gemini API for travel analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzeTravelDataWithGemini(data, apiKey);

            // Add weather data if applicable
            if (data.type === 'destinations' || data.type === 'hotels') {
                enrichedData.weather = await this.getWeatherData(data.location);
            }

            // Add local events and activities
            enrichedData.localEvents = await this.getLocalEvents(data.location);

            return {
                ...data,
                analysis: enrichedData
            };
        } catch (error) {
            this.logger.error('Travel data enrichment failed:', error);
            return data;
        }
    }

    async analyzeTravelDataWithGemini(data, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this travel data and provide insights on:
            1. Best booking times and prices
            2. Seasonal trends
            3. Alternative options
            4. Local recommendations
            5. Travel tips
            6. Safety considerations
            7. Cultural highlights
            8. Budget optimization

            Travel Data:
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

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: this.determineDataType(taskConfig),
            dates: taskConfig.dates,
            location: taskConfig.location,
            timestamp: Math.floor(Date.now() / (1000 * 60 * 15)) // 15-minute buckets
        };
        return JSON.stringify(key);
    }

    getCacheTTL(dataType) {
        // Different TTLs based on data type
        const ttls = {
            flights: 900,      // 15 minutes
            hotels: 1800,      // 30 minutes
            reviews: 86400,    // 24 hours
            destinations: 43200 // 12 hours
        };
        return ttls[dataType] || 3600;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative travel data sources
        const sources = [
            this.tryAlternativeFlightAPI,
            this.tryAlternativeHotelAPI,
            this.tryMetasearch
        ];

        for (const source of sources) {
            try {
                const result = await source.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to fetch travel data from all sources');
    }
}

module.exports = { TravelHandler };
