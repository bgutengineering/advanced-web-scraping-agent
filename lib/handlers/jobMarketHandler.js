const { BaseHandler } = require('./baseHandler');

class JobMarketHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'job_market';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting job market scraping task', { taskConfig });

        try {
            // Check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData) {
                this.logger.info('Returning cached job market data');
                return cachedData;
            }

            // Initialize tools based on configuration
            const result = await this.scrapeWithPrimaryTool(taskConfig);

            // Cache the results
            await this.cacheSet(cacheKey, result);

            return result;
        } catch (error) {
            // If primary tool fails, try fallback tools
            if (error.message.toLowerCase().includes('captcha')) {
                this.logger.warn('Captcha detected, switching to fallback tool');
                return this.handleCaptchaFailover(taskConfig);
            }

            throw error;
        }
    }

    async scrapeWithPrimaryTool(taskConfig) {
        // Job sites typically require JavaScript, so we use Playwright
        return this.withPage(async (page) => {
            // Configure request interception
            await this.setupJobSiteInterception(page);

            // Navigate to the job site
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle any login if required
            if (taskConfig.credentials) {
                await this.handleLogin(page, taskConfig.credentials);
            }

            // Wait for job listings to load
            await page.waitForSelector(this.config.settings.wait_for);

            // Extract job data
            const jobs = await this.extractJobData(page, taskConfig);

            // Enrich data with additional details if needed
            return this.enrichJobData(jobs, taskConfig);
        }, true); // Always use proxy for job sites
    }

    async setupJobSiteInterception(page) {
        // Block unnecessary resources
        await page.route('**/*', (route) => {
            const request = route.request();
            if (this.shouldBlockResource(request)) {
                return route.abort();
            }
            return route.continue();
        });

        // Monitor for anti-bot detection
        page.on('response', async (response) => {
            const url = response.url();
            const status = response.status();
            
            if (this.isAntiBotResponse(url, status)) {
                throw new Error('Anti-bot detection triggered');
            }
        });
    }

    shouldBlockResource(request) {
        const blockedResourceTypes = [
            'image',
            'media',
            'font',
            'stylesheet'
        ];
        return blockedResourceTypes.includes(request.resourceType());
    }

    isAntiBotResponse(url, status) {
        return (
            status === 403 ||
            url.includes('captcha') ||
            url.includes('security-check')
        );
    }

    async handleLogin(page, credentials) {
        try {
            // Wait for login form
            await page.waitForSelector(credentials.loginSelector);
            
            // Fill credentials
            await page.fill(credentials.usernameSelector, credentials.username);
            await page.fill(credentials.passwordSelector, credentials.password);
            
            // Submit form
            await Promise.all([
                page.waitForNavigation(),
                page.click(credentials.submitSelector)
            ]);
        } catch (error) {
            this.logger.error('Login failed:', error);
            throw error;
        }
    }

    async extractJobData(page, taskConfig) {
        return page.evaluate((config) => {
            const jobs = [];
            const listings = document.querySelectorAll(config.selectors.jobListing);

            listings.forEach((listing) => {
                try {
                    const job = {
                        title: this.extractText(listing, config.selectors.title),
                        company: this.extractText(listing, config.selectors.company),
                        location: this.extractText(listing, config.selectors.location),
                        salary: this.extractText(listing, config.selectors.salary),
                        description: this.extractText(listing, config.selectors.description),
                        requirements: this.extractText(listing, config.selectors.requirements),
                        url: this.extractHref(listing, config.selectors.url),
                        postedDate: this.extractText(listing, config.selectors.postedDate),
                        metadata: this.extractMetadata(listing, config.selectors.metadata)
                    };

                    jobs.push(job);
                } catch (error) {
                    console.error('Error extracting job data:', error);
                }
            });

            return jobs;
        }, taskConfig);
    }

    async enrichJobData(jobs, taskConfig) {
        const enrichedJobs = [];

        for (const job of jobs) {
            try {
                // Use Gemini API for advanced analysis
                const apiKey = await this.getApiKey('gemini');
                const enrichedData = await this.analyzeJobWithGemini(job, apiKey);

                enrichedJobs.push({
                    ...job,
                    ...enrichedData
                });
            } catch (error) {
                this.logger.error('Job enrichment failed:', error);
                enrichedJobs.push(job);
            }
        }

        return enrichedJobs;
    }

    async analyzeJobWithGemini(job, apiKey) {
        // Initialize Gemini API
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this job posting and extract the following information:
            1. Required skills and their importance level
            2. Experience level (entry, mid, senior)
            3. Employment type (full-time, contract, etc.)
            4. Industry sector
            5. Key technologies mentioned
            6. Estimated salary range if not explicitly stated
            7. Company size and type if determinable
            8. Remote work possibilities
            9. Benefits mentioned
            10. Red flags or potential concerns

            Job Details:
            ${JSON.stringify(job, null, 2)}
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

    async handleCaptchaFailover(taskConfig) {
        // Try Apify as fallback
        this.logger.info('Attempting to use Apify as fallback');
        
        const apifyClient = require('apify-client');
        const client = new apifyClient.ApifyClient({
            token: await this.getApiKey('apify')
        });

        const run = await client.actor('custom-job-scraper').call({
            url: taskConfig.url,
            ...taskConfig
        });

        return await run.dataset().getData();
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            filters: taskConfig.filters || {},
            timestamp: Math.floor(Date.now() / (1000 * 60 * 15)) // 15-minute buckets
        };
        return JSON.stringify(key);
    }
}

module.exports = { JobMarketHandler };
