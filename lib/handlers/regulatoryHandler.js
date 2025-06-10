const { BaseHandler } = require('./baseHandler');
const { validateDocument } = require('../utils/validators');
const { parseRegulation } = require('../utils/regulatoryParser');

class RegulatoryHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'regulatory';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting regulatory data scraping task', { taskConfig });

        try {
            // Check cache for non-time-sensitive data
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached regulatory data');
                return cachedData;
            }

            // Determine document type and appropriate handling method
            const documentType = this.determineDocumentType(taskConfig);
            let result;

            switch (documentType) {
                case 'compliance':
                    result = await this.handleComplianceDoc(taskConfig);
                    break;
                case 'legal_filing':
                    result = await this.handleLegalFiling(taskConfig);
                    break;
                case 'regulatory_update':
                    result = await this.handleRegulatoryUpdate(taskConfig);
                    break;
                case 'policy_document':
                    result = await this.handlePolicyDocument(taskConfig);
                    break;
                default:
                    result = await this.handleGenericRegulatory(taskConfig);
            }

            // Validate and enrich regulatory data
            const enrichedData = await this.enrichRegulatoryData(result, taskConfig);

            // Cache the results
            await this.cacheSet(cacheKey, enrichedData, this.getCacheTTL(documentType));

            return enrichedData;
        } catch (error) {
            this.logger.error('Regulatory data processing failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    determineDocumentType(taskConfig) {
        if (taskConfig.url.match(/compliance|standard|requirement/)) {
            return 'compliance';
        }
        if (taskConfig.url.match(/legal|court|filing/)) {
            return 'legal_filing';
        }
        if (taskConfig.url.match(/update|amendment|change/)) {
            return 'regulatory_update';
        }
        if (taskConfig.url.match(/policy|guideline|procedure/)) {
            return 'policy_document';
        }
        return 'generic';
    }

    async handleComplianceDoc(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract compliance document information
            const complianceData = await page.evaluate(() => {
                return {
                    title: document.querySelector('.document-title')?.textContent,
                    authority: document.querySelector('.issuing-authority')?.textContent,
                    effectiveDate: document.querySelector('.effective-date')?.textContent,
                    scope: document.querySelector('.scope')?.textContent,
                    requirements: Array.from(document.querySelectorAll('.requirement'))
                        .map(req => ({
                            id: req.querySelector('.req-id')?.textContent,
                            description: req.querySelector('.description')?.textContent,
                            criteria: req.querySelector('.criteria')?.textContent,
                            evidence: req.querySelector('.evidence')?.textContent
                        })),
                    attachments: Array.from(document.querySelectorAll('.attachment'))
                        .map(att => ({
                            name: att.querySelector('.name')?.textContent,
                            type: att.querySelector('.type')?.textContent,
                            url: att.querySelector('a')?.href
                        }))
                };
            });

            return this.validateComplianceDocument(complianceData);
        });
    }

    async handleLegalFiling(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract legal filing information
            const filingData = await page.evaluate(() => {
                return {
                    caseNumber: document.querySelector('.case-number')?.textContent,
                    filingDate: document.querySelector('.filing-date')?.textContent,
                    jurisdiction: document.querySelector('.jurisdiction')?.textContent,
                    parties: Array.from(document.querySelectorAll('.party'))
                        .map(party => ({
                            name: party.querySelector('.name')?.textContent,
                            type: party.querySelector('.type')?.textContent,
                            representation: party.querySelector('.representation')?.textContent
                        })),
                    documents: Array.from(document.querySelectorAll('.document'))
                        .map(doc => ({
                            title: doc.querySelector('.title')?.textContent,
                            type: doc.querySelector('.type')?.textContent,
                            filingDate: doc.querySelector('.date')?.textContent,
                            status: doc.querySelector('.status')?.textContent
                        })),
                    status: document.querySelector('.case-status')?.textContent,
                    summary: document.querySelector('.case-summary')?.textContent
                };
            });

            return this.validateLegalFiling(filingData);
        });
    }

    async handleRegulatoryUpdate(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract regulatory update information
            const updateData = await page.evaluate(() => {
                return {
                    title: document.querySelector('.update-title')?.textContent,
                    agency: document.querySelector('.agency')?.textContent,
                    publicationDate: document.querySelector('.pub-date')?.textContent,
                    effectiveDate: document.querySelector('.effective-date')?.textContent,
                    summary: document.querySelector('.summary')?.textContent,
                    changes: Array.from(document.querySelectorAll('.change'))
                        .map(change => ({
                            section: change.querySelector('.section')?.textContent,
                            description: change.querySelector('.description')?.textContent,
                            impact: change.querySelector('.impact')?.textContent
                        })),
                    comments: Array.from(document.querySelectorAll('.comment'))
                        .map(comment => ({
                            author: comment.querySelector('.author')?.textContent,
                            date: comment.querySelector('.date')?.textContent,
                            content: comment.querySelector('.content')?.textContent
                        }))
                };
            });

            return this.validateRegulatoryUpdate(updateData);
        });
    }

    async handlePolicyDocument(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract policy document information
            const policyData = await page.evaluate(() => {
                return {
                    title: document.querySelector('.policy-title')?.textContent,
                    version: document.querySelector('.version')?.textContent,
                    approvalDate: document.querySelector('.approval-date')?.textContent,
                    department: document.querySelector('.department')?.textContent,
                    scope: document.querySelector('.scope')?.textContent,
                    sections: Array.from(document.querySelectorAll('.policy-section'))
                        .map(section => ({
                            title: section.querySelector('.title')?.textContent,
                            content: section.querySelector('.content')?.textContent,
                            requirements: Array.from(section.querySelectorAll('.requirement'))
                                .map(req => req.textContent)
                        })),
                    references: Array.from(document.querySelectorAll('.reference'))
                        .map(ref => ({
                            title: ref.querySelector('.title')?.textContent,
                            link: ref.querySelector('a')?.href
                        }))
                };
            });

            return this.validatePolicyDocument(policyData);
        });
    }

    async enrichRegulatoryData(data, taskConfig) {
        try {
            // Use Gemini API for regulatory analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzeRegulatoryWithGemini(data, apiKey);

            // Add compliance assessment
            enrichedData.compliance = await this.assessCompliance(data);

            // Add related regulations
            enrichedData.relatedRegulations = await this.findRelatedRegulations(data);

            // Add impact analysis
            enrichedData.impactAnalysis = await this.analyzeImpact(data);

            return {
                ...data,
                analysis: enrichedData
            };
        } catch (error) {
            this.logger.error('Regulatory data enrichment failed:', error);
            return data;
        }
    }

    async analyzeRegulatoryWithGemini(data, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this regulatory document and provide insights on:
            1. Key compliance requirements
            2. Implementation timeline
            3. Potential risks and challenges
            4. Required actions
            5. Industry impact
            6. Compliance costs
            7. Best practices
            8. Monitoring requirements

            Regulatory Data:
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

    async assessCompliance(data) {
        return {
            requirements: this.extractRequirements(data),
            gaps: await this.identifyComplianceGaps(data),
            recommendations: await this.generateRecommendations(data),
            timeline: this.createComplianceTimeline(data)
        };
    }

    async findRelatedRegulations(data) {
        // Search for related regulations
        const relatedDocs = await this.searchRegulatoryDatabase(data);
        return relatedDocs.map(doc => ({
            title: doc.title,
            relevance: doc.relevance,
            relationship: doc.relationship,
            summary: doc.summary
        }));
    }

    async analyzeImpact(data) {
        return {
            businessImpact: this.assessBusinessImpact(data),
            operationalChanges: this.identifyOperationalChanges(data),
            resourceRequirements: this.calculateResourceRequirements(data),
            risks: this.assessRisks(data)
        };
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: this.determineDocumentType(taskConfig),
            jurisdiction: taskConfig.jurisdiction,
            timestamp: Math.floor(Date.now() / (1000 * 3600)) // 1-hour buckets
        };
        return JSON.stringify(key);
    }

    getCacheTTL(documentType) {
        // Different TTLs based on document type
        const ttls = {
            compliance: 86400,         // 24 hours
            legal_filing: 43200,       // 12 hours
            regulatory_update: 3600,    // 1 hour
            policy_document: 86400      // 24 hours
        };
        return ttls[documentType] || 43200;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative regulatory data sources
        const sources = [
            this.tryRegulatoryAPI,
            this.tryLegalDatabase,
            this.tryGovernmentPortal
        ];

        for (const source of sources) {
            try {
                const result = await source.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to fetch regulatory data from all sources');
    }
}

module.exports = { RegulatoryHandler };
