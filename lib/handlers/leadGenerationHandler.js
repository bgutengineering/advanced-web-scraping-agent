const { BaseHandler } = require('./baseHandler');
const { validateEmail, validatePhone } = require('../utils/validators');

class LeadGenerationHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'lead_generation';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting lead generation task', { taskConfig });

        try {
            // Check cache first for non-time-sensitive data
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached lead data');
                return cachedData;
            }

            // Determine data type and appropriate handling method
            const dataType = this.determineDataType(taskConfig);
            let result;

            switch (dataType) {
                case 'company_profile':
                    result = await this.handleCompanyProfile(taskConfig);
                    break;
                case 'contact_info':
                    result = await this.handleContactInfo(taskConfig);
                    break;
                case 'professional_network':
                    result = await this.handleProfessionalNetwork(taskConfig);
                    break;
                case 'business_directory':
                    result = await this.handleBusinessDirectory(taskConfig);
                    break;
                default:
                    result = await this.handleGenericLeadData(taskConfig);
            }

            // Validate and enrich lead data
            const enrichedData = await this.enrichLeadData(result, taskConfig);

            // Cache the results
            await this.cacheSet(cacheKey, enrichedData, this.getCacheTTL(dataType));

            return enrichedData;
        } catch (error) {
            this.logger.error('Lead generation failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    determineDataType(taskConfig) {
        if (taskConfig.url.match(/company|business|org/)) {
            return 'company_profile';
        }
        if (taskConfig.url.match(/contact|people|employee/)) {
            return 'contact_info';
        }
        if (taskConfig.url.match(/linkedin|xing|professional/)) {
            return 'professional_network';
        }
        if (taskConfig.url.match(/directory|listing|yellow/)) {
            return 'business_directory';
        }
        return 'generic';
    }

    async handleCompanyProfile(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract company information
            const companyData = await page.evaluate(() => {
                return {
                    name: document.querySelector('.company-name')?.textContent,
                    description: document.querySelector('.description')?.textContent,
                    industry: document.querySelector('.industry')?.textContent,
                    size: document.querySelector('.company-size')?.textContent,
                    location: {
                        address: document.querySelector('.address')?.textContent,
                        city: document.querySelector('.city')?.textContent,
                        country: document.querySelector('.country')?.textContent
                    },
                    contact: {
                        phone: document.querySelector('.phone')?.textContent,
                        email: document.querySelector('.email')?.textContent,
                        website: document.querySelector('.website')?.href
                    },
                    social: {
                        linkedin: document.querySelector('.linkedin')?.href,
                        twitter: document.querySelector('.twitter')?.href,
                        facebook: document.querySelector('.facebook')?.href
                    }
                };
            });

            return this.validateCompanyData(companyData);
        });
    }

    async handleContactInfo(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract contact information
            const contacts = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.contact-card'))
                    .map(contact => ({
                        name: contact.querySelector('.name')?.textContent,
                        title: contact.querySelector('.title')?.textContent,
                        company: contact.querySelector('.company')?.textContent,
                        email: contact.querySelector('.email')?.textContent,
                        phone: contact.querySelector('.phone')?.textContent,
                        location: contact.querySelector('.location')?.textContent,
                        department: contact.querySelector('.department')?.textContent,
                        linkedin: contact.querySelector('.linkedin')?.href
                    }));
            });

            return this.validateContactData(contacts);
        });
    }

    async handleProfessionalNetwork(taskConfig) {
        return this.withPage(async (page) => {
            // Handle professional network login if required
            if (taskConfig.credentials) {
                await this.handleProfessionalNetworkLogin(page, taskConfig.credentials);
            }

            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract professional network data
            const networkData = await page.evaluate(() => {
                return {
                    profile: {
                        name: document.querySelector('.profile-name')?.textContent,
                        headline: document.querySelector('.headline')?.textContent,
                        company: document.querySelector('.current-company')?.textContent,
                        location: document.querySelector('.location')?.textContent
                    },
                    experience: Array.from(document.querySelectorAll('.experience-item'))
                        .map(exp => ({
                            title: exp.querySelector('.title')?.textContent,
                            company: exp.querySelector('.company')?.textContent,
                            duration: exp.querySelector('.duration')?.textContent,
                            description: exp.querySelector('.description')?.textContent
                        })),
                    education: Array.from(document.querySelectorAll('.education-item'))
                        .map(edu => ({
                            school: edu.querySelector('.school')?.textContent,
                            degree: edu.querySelector('.degree')?.textContent,
                            field: edu.querySelector('.field')?.textContent,
                            year: edu.querySelector('.year')?.textContent
                        })),
                    skills: Array.from(document.querySelectorAll('.skill'))
                        .map(skill => skill.textContent)
                };
            });

            return this.processNetworkData(networkData);
        });
    }

    async handleBusinessDirectory(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract business directory listings
            const listings = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('.business-listing'))
                    .map(listing => ({
                        name: listing.querySelector('.name')?.textContent,
                        category: listing.querySelector('.category')?.textContent,
                        address: listing.querySelector('.address')?.textContent,
                        phone: listing.querySelector('.phone')?.textContent,
                        email: listing.querySelector('.email')?.textContent,
                        website: listing.querySelector('.website')?.href,
                        description: listing.querySelector('.description')?.textContent,
                        hours: listing.querySelector('.hours')?.textContent
                    }));
            });

            return this.validateBusinessListings(listings);
        });
    }

    async enrichLeadData(data, taskConfig) {
        try {
            // Use Gemini API for lead analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzeLeadWithGemini(data, apiKey);

            // Add company insights
            if (data.type === 'company_profile') {
                enrichedData.insights = await this.getCompanyInsights(data);
            }

            // Add contact verification
            if (data.type === 'contact_info') {
                enrichedData.verification = await this.verifyContactInfo(data);
            }

            return {
                ...data,
                analysis: enrichedData
            };
        } catch (error) {
            this.logger.error('Lead data enrichment failed:', error);
            return data;
        }
    }

    async analyzeLeadWithGemini(data, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this lead data and provide insights on:
            1. Lead quality assessment
            2. Company profile analysis
            3. Industry insights
            4. Growth indicators
            5. Potential opportunities
            6. Risk factors
            7. Recommended approach
            8. Similar companies/contacts

            Lead Data:
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

    async verifyContactInfo(data) {
        const verificationResults = {
            email: await this.verifyEmail(data.email),
            phone: await this.verifyPhone(data.phone),
            address: await this.verifyAddress(data.location),
            social: await this.verifySocialProfiles(data.social)
        };

        return {
            ...verificationResults,
            score: this.calculateVerificationScore(verificationResults)
        };
    }

    async getCompanyInsights(data) {
        return {
            financials: await this.getCompanyFinancials(data),
            technology: await this.getCompanyTechnology(data),
            competitors: await this.getCompanyCompetitors(data),
            news: await this.getCompanyNews(data)
        };
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: this.determineDataType(taskConfig),
            filters: taskConfig.filters || {},
            timestamp: Math.floor(Date.now() / (1000 * 3600)) // 1-hour buckets
        };
        return JSON.stringify(key);
    }

    getCacheTTL(dataType) {
        // Different TTLs based on data type
        const ttls = {
            company_profile: 86400,    // 24 hours
            contact_info: 43200,       // 12 hours
            professional_network: 7200, // 2 hours
            business_directory: 86400   // 24 hours
        };
        return ttls[dataType] || 43200;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative data sources
        const sources = [
            this.tryAlternativeBusinessDB,
            this.tryContactAPI,
            this.tryLinkedInAPI
        ];

        for (const source of sources) {
            try {
                const result = await source.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to generate leads from all sources');
    }
}

module.exports = { LeadGenerationHandler };
