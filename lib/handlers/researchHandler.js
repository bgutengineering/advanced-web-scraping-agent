const { BaseHandler } = require('./baseHandler');
const { PDFDocument } = require('pdf-lib');
const { createWorker } = require('tesseract.js');
const bibtexParse = require('bibtex-parse');

class ResearchHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'research_docs';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
        this.ocrWorker = null;
    }

    async execute(taskConfig) {
        this.logger.info('Starting research document scraping task', { taskConfig });

        try {
            // Check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached research data');
                return cachedData;
            }

            // Determine document type and appropriate handling method
            const documentType = await this.determineDocumentType(taskConfig.url);
            let result;

            switch (documentType) {
                case 'pdf':
                    result = await this.handlePdfDocument(taskConfig);
                    break;
                case 'academic':
                    result = await this.handleAcademicPaper(taskConfig);
                    break;
                case 'technical':
                    result = await this.handleTechnicalDoc(taskConfig);
                    break;
                case 'public_record':
                    result = await this.handlePublicRecord(taskConfig);
                    break;
                default:
                    result = await this.handleGenericDocument(taskConfig);
            }

            // Enrich with metadata and citations
            const enrichedData = await this.enrichDocumentData(result, taskConfig);

            // Cache the results
            await this.cacheSet(cacheKey, enrichedData, this.getCacheTTL(documentType));

            return enrichedData;
        } catch (error) {
            this.logger.error('Research document processing failed:', error);
            return this.handleFailover(taskConfig, error);
        } finally {
            // Cleanup OCR worker if initialized
            if (this.ocrWorker) {
                await this.ocrWorker.terminate();
                this.ocrWorker = null;
            }
        }
    }

    async determineDocumentType(url) {
        if (url.endsWith('.pdf')) {
            return 'pdf';
        }
        if (url.match(/arxiv|doi\.org|sciencedirect|springer|ieee/)) {
            return 'academic';
        }
        if (url.match(/docs|documentation|manual|guide/)) {
            return 'technical';
        }
        if (url.match(/gov|public|record|registry/)) {
            return 'public_record';
        }
        return 'generic';
    }

    async handlePdfDocument(taskConfig) {
        const response = await fetch(taskConfig.url);
        const pdfBuffer = await response.arrayBuffer();

        // Load PDF document
        const pdfDoc = await PDFDocument.load(pdfBuffer);
        const numPages = pdfDoc.getPageCount();

        // Extract text and process each page
        const pages = [];
        for (let i = 0; i < numPages; i++) {
            const page = pdfDoc.getPage(i);
            const text = await this.extractPageText(page);
            const images = await this.extractPageImages(page);
            
            pages.push({
                pageNumber: i + 1,
                text,
                images,
                tables: await this.extractTables(page),
                figures: await this.extractFigures(page)
            });
        }

        // Extract document metadata
        const metadata = await this.extractPdfMetadata(pdfDoc);

        return {
            type: 'pdf',
            metadata,
            pages,
            references: await this.extractReferences(pages),
            citations: await this.extractCitations(pages)
        };
    }

    async extractPageText(page) {
        let text = await page.getText();
        
        // If text extraction fails or returns empty, try OCR
        if (!text.trim()) {
            text = await this.performOCR(page);
        }

        return this.processExtractedText(text);
    }

    async performOCR(page) {
        if (!this.ocrWorker) {
            this.ocrWorker = await createWorker();
            await this.ocrWorker.loadLanguage('eng');
            await this.ocrWorker.initialize('eng');
        }

        const { data: { text } } = await this.ocrWorker.recognize(page);
        return text;
    }

    async handleAcademicPaper(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle login if required
            if (taskConfig.credentials) {
                await this.handleAcademicLogin(page, taskConfig.credentials);
            }

            // Extract paper details
            const paperData = await page.evaluate(() => {
                return {
                    title: document.querySelector('h1, .paper-title')?.textContent,
                    authors: Array.from(document.querySelectorAll('.author'))
                        .map(author => ({
                            name: author.textContent,
                            affiliation: author.getAttribute('data-affiliation'),
                            email: author.getAttribute('data-email')
                        })),
                    abstract: document.querySelector('.abstract')?.textContent,
                    keywords: Array.from(document.querySelectorAll('.keyword'))
                        .map(kw => kw.textContent),
                    doi: document.querySelector('.doi')?.textContent,
                    publicationDate: document.querySelector('.publication-date')?.textContent,
                    journal: document.querySelector('.journal-name')?.textContent
                };
            });

            // Extract citations and references
            const citations = await this.extractAcademicCitations(page);
            const references = await this.extractAcademicReferences(page);

            return {
                type: 'academic',
                ...paperData,
                citations,
                references
            };
        });
    }

    async handleTechnicalDoc(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract documentation structure
            const structure = await page.evaluate(() => {
                return {
                    title: document.querySelector('h1')?.textContent,
                    sections: Array.from(document.querySelectorAll('h2, h3, h4'))
                        .map(heading => ({
                            level: parseInt(heading.tagName.slice(1)),
                            title: heading.textContent,
                            id: heading.id
                        })),
                    codeBlocks: Array.from(document.querySelectorAll('pre code'))
                        .map(code => ({
                            language: code.className.replace('language-', ''),
                            content: code.textContent
                        })),
                    examples: Array.from(document.querySelectorAll('.example'))
                        .map(example => example.innerHTML)
                };
            });

            // Process code samples and examples
            const processedContent = await this.processTechnicalContent(structure);

            return {
                type: 'technical',
                ...processedContent
            };
        });
    }

    async handlePublicRecord(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract record information
            const recordData = await page.evaluate(() => {
                return {
                    recordType: document.querySelector('.record-type')?.textContent,
                    recordNumber: document.querySelector('.record-number')?.textContent,
                    filingDate: document.querySelector('.filing-date')?.textContent,
                    jurisdiction: document.querySelector('.jurisdiction')?.textContent,
                    parties: Array.from(document.querySelectorAll('.party'))
                        .map(party => ({
                            name: party.querySelector('.name')?.textContent,
                            role: party.querySelector('.role')?.textContent,
                            details: party.querySelector('.details')?.textContent
                        })),
                    content: document.querySelector('.record-content')?.innerHTML
                };
            });

            // Process and validate record data
            const processedRecord = await this.processPublicRecord(recordData);

            return {
                type: 'public_record',
                ...processedRecord
            };
        });
    }

    async enrichDocumentData(data, taskConfig) {
        try {
            // Use Gemini API for document analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzeDocumentWithGemini(data, apiKey);

            // Add citation analysis
            if (data.citations) {
                enrichedData.citationAnalysis = await this.analyzeCitations(data.citations);
            }

            // Add reference network
            if (data.references) {
                enrichedData.referenceNetwork = await this.buildReferenceNetwork(data.references);
            }

            return {
                ...data,
                analysis: enrichedData
            };
        } catch (error) {
            this.logger.error('Document enrichment failed:', error);
            return data;
        }
    }

    async analyzeDocumentWithGemini(data, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this research document and provide insights on:
            1. Main research contributions
            2. Methodology assessment
            3. Key findings and implications
            4. Research quality indicators
            5. Related research areas
            6. Technical complexity level
            7. Practical applications
            8. Future research directions

            Document:
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

    async analyzeCitations(citations) {
        // Analyze citation patterns and impact
        return {
            totalCount: citations.length,
            byYear: this.groupCitationsByYear(citations),
            impactMetrics: await this.calculateImpactMetrics(citations),
            networkAnalysis: await this.analyzeCitationNetwork(citations)
        };
    }

    async buildReferenceNetwork(references) {
        // Build network graph of references
        return {
            nodes: this.createReferenceNodes(references),
            edges: this.createReferenceEdges(references),
            metrics: await this.calculateNetworkMetrics(references)
        };
    }

    generateCacheKey(taskConfig) {
        const key = {
            url: taskConfig.url,
            type: this.determineDocumentType(taskConfig.url),
            timestamp: Math.floor(Date.now() / (1000 * 3600)) // 1-hour buckets
        };
        return JSON.stringify(key);
    }

    getCacheTTL(documentType) {
        // Different TTLs based on document type
        const ttls = {
            pdf: 86400,         // 24 hours
            academic: 86400,    // 24 hours
            technical: 43200,   // 12 hours
            public_record: 7200 // 2 hours
        };
        return ttls[documentType] || 86400;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative methods
        const methods = [
            this.tryApifyActor,
            this.tryExaAI,
            this.tryGooseCSE
        ];

        for (const method of methods) {
            try {
                const result = await method.call(this, taskConfig);
                if (result) return result;
            } catch (error) {
                continue;
            }
        }

        throw new Error('Failed to process research document from all sources');
    }
}

module.exports = { ResearchHandler };
