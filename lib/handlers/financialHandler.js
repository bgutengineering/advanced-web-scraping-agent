const { BaseHandler } = require('./baseHandler');
const WebSocket = require('ws');

class FinancialHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'financial';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
        this.activeWebSockets = new Map();
    }

    async execute(taskConfig) {
        this.logger.info('Starting financial data scraping task', { taskConfig });

        try {
            // For real-time data, check if we need live updates
            if (taskConfig.realTime) {
                return this.handleRealTimeData(taskConfig);
            }

            // For historical/static data, check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached financial data');
                return cachedData;
            }

            // Determine data type and appropriate handling method
            const dataType = this.determineDataType(taskConfig);
            let result;

            switch (dataType) {
                case 'market_data':
                    result = await this.handleMarketData(taskConfig);
                    break;
                case 'financial_statements':
                    result = await this.handleFinancialStatements(taskConfig);
                    break;
                case 'sec_filings':
                    result = await this.handleSECFilings(taskConfig);
                    break;
                case 'earnings':
                    result = await this.handleEarningsData(taskConfig);
                    break;
                default:
                    result = await this.handleGenericFinancialData(taskConfig);
            }

            // Enrich with analysis and metadata
            const enrichedData = await this.enrichFinancialData(result, taskConfig);

            // Cache the results if not real-time
            if (!taskConfig.realTime) {
                await this.cacheSet(cacheKey, enrichedData, this.getCacheTTL(dataType));
            }

            return enrichedData;
        } catch (error) {
            this.logger.error('Financial data processing failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    determineDataType(taskConfig) {
        if (taskConfig.url.match(/quote|price|ticker/)) {
            return 'market_data';
        }
        if (taskConfig.url.match(/financial-statements|balance-sheet|income-statement/)) {
            return 'financial_statements';
        }
        if (taskConfig.url.match(/sec|edgar|filing/)) {
            return 'sec_filings';
        }
        if (taskConfig.url.match(/earnings|results/)) {
            return 'earnings';
        }
        return 'generic';
    }

    async handleRealTimeData(taskConfig) {
        const streamId = this.generateStreamId(taskConfig);
        
        // Set up WebSocket connection for real-time data
        const ws = await this.setupWebSocket(taskConfig);
        this.activeWebSockets.set(streamId, ws);

        // Return initial data and stream ID
        const initialData = await this.fetchInitialData(taskConfig);
        return {
            streamId,
            initialData,
            type: 'real_time',
            timestamp: new Date().toISOString()
        };
    }

    async setupWebSocket(taskConfig) {
        const ws = new WebSocket(this.getWebSocketUrl(taskConfig));
        
        ws.on('open', () => {
            this.logger.info('WebSocket connection established');
            this.subscribeToMarketData(ws, taskConfig);
        });

        ws.on('message', (data) => {
            this.handleMarketDataUpdate(data, taskConfig);
        });

        ws.on('error', (error) => {
            this.logger.error('WebSocket error:', error);
            this.handleWebSocketError(error, taskConfig);
        });

        return ws;
    }

    async handleMarketData(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract market data
            const marketData = await page.evaluate(() => {
                return {
                    symbol: document.querySelector('.symbol')?.textContent,
                    price: document.querySelector('.price')?.textContent,
                    change: document.querySelector('.change')?.textContent,
                    volume: document.querySelector('.volume')?.textContent,
                    marketCap: document.querySelector('.market-cap')?.textContent,
                    peRatio: document.querySelector('.pe-ratio')?.textContent,
                    dividend: document.querySelector('.dividend')?.textContent,
                    timestamp: new Date().toISOString()
                };
            });

            // Validate and normalize data
            return this.normalizeMarketData(marketData);
        });
    }

    async handleFinancialStatements(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract financial statements
            const statements = await page.evaluate(() => {
                return {
                    type: document.querySelector('.statement-type')?.textContent,
                    period: document.querySelector('.period')?.textContent,
                    currency: document.querySelector('.currency')?.textContent,
                    items: Array.from(document.querySelectorAll('.statement-item'))
                        .map(item => ({
                            label: item.querySelector('.label')?.textContent,
                            value: item.querySelector('.value')?.textContent,
                            period: item.querySelector('.item-period')?.textContent
                        }))
                };
            });

            // Process and validate statements
            return this.processFinancialStatements(statements);
        });
    }

    async handleSECFilings(taskConfig) {
        // Use EDGAR API for SEC filings
        const response = await fetch(
            `https://www.sec.gov/cgi-bin/browse-edgar?CIK=${taskConfig.cik}&type=${taskConfig.formType}`,
            {
                headers: {
                    'User-Agent': 'Company Name Contact@email.com'
                }
            }
        );

        const filings = await response.text();
        return this.parseEDGARFilings(filings);
    }

    async handleEarningsData(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract earnings data
            const earningsData = await page.evaluate(() => {
                return {
                    company: document.querySelector('.company-name')?.textContent,
                    period: document.querySelector('.earnings-period')?.textContent,
                    eps: {
                        actual: document.querySelector('.eps-actual')?.textContent,
                        estimate: document.querySelector('.eps-estimate')?.textContent
                    },
                    revenue: {
                        actual: document.querySelector('.revenue-actual')?.textContent,
                        estimate: document.querySelector('.revenue-estimate')?.textContent
                    },
                    guidance: document.querySelector('.guidance')?.textContent
                };
            });

            // Process and validate earnings data
            return this.processEarningsData(earningsData);
        });
    }

    async enrichFinancialData(data, taskConfig) {
        try {
            // Use Gemini API for financial analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzeFinancialDataWithGemini(data, apiKey);

            // Add technical analysis if applicable
            if (data.type === 'market_data') {
                enrichedData.technicalAnalysis = await this.performTechnicalAnalysis(data);
            }

            // Add market sentiment analysis
            enrichedData.sentiment = await this.analyzeSentiment(data);

            return {
                ...data,
                analysis: enrichedData
            };
        } catch (error) {
            this.logger.error('Financial data enrichment failed:', error);
            return data;
        }
    }

    async analyzeFinancialDataWithGemini(data, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this financial data and provide insights on:
            1. Key performance indicators
            2. Market trends and patterns
            3. Risk assessment
            4. Comparative analysis
            5. Investment implications
            6. Notable anomalies
            7. Future projections
            8. Market sentiment indicators

            Financial Data:
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

    async performTechnicalAnalysis(data) {
        // Implement technical analysis indicators
        return {
            movingAverages: this.calculateMovingAverages(data),
            relativeStrengthIndex: this.calculateRSI(data),
            macdIndicator: this.calculateMACD(data),
            bollingerBands: this.calculateBollingerBands(data)
        };
    }

    async analyzeSentiment(data) {
        // Analyze market sentiment from various sources
        return {
            marketSentiment: await this.getMarketSentiment(data),
            newsSentiment: await this.getNewsSentiment(data),
            socialMediaSentiment: await this.getSocialMediaSentiment(data)
        };
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: this.determineDataType(taskConfig),
            symbol: taskConfig.symbol,
            timestamp: Math.floor(Date.now() / (1000 * 60)) // 1-minute buckets for financial data
        };
        return JSON.stringify(key);
    }

    getCacheTTL(dataType) {
        // Different TTLs based on data type
        const ttls = {
            market_data: 60,     // 1 minute
            financial_statements: 86400, // 24 hours
            sec_filings: 3600,   // 1 hour
            earnings: 1800       // 30 minutes
        };
        return ttls[dataType] || 300; // Default 5 minutes
    }

    async handleFailover(taskConfig, error) {
        // Try alternative data sources
        const sources = [
            this.tryAlternativeMarketData,
            this.tryFinancialAPI,
            this.trySECAPI
        ];

        for (const source of sources) {
            try {
                const result = await source.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to fetch financial data from all sources');
    }

    cleanup() {
        // Close all active WebSocket connections
        for (const [streamId, ws] of this.activeWebSockets) {
            try {
                ws.close();
                this.activeWebSockets.delete(streamId);
            } catch (error) {
                this.logger.error(`Failed to close WebSocket for stream ${streamId}:`, error);
            }
        }
    }
}

module.exports = { FinancialHandler };
