const { BaseHandler } = require('./baseHandler');
const cheerio = require('cheerio');
const { sanitizeHtml, extractMetadata } = require('../utils/contentUtils');

class ContentAggregationHandler extends BaseHandler {
    constructor(options) {
        super(options);
        this.category = 'content_aggregation';
        this.validateConfig(this.config, [
            'tools',
            'features',
            'settings'
        ]);
    }

    async execute(taskConfig) {
        this.logger.info('Starting content aggregation task', { taskConfig });

        try {
            // Check cache first
            const cacheKey = this.generateCacheKey(taskConfig);
            const cachedData = await this.cacheGet(cacheKey);
            if (cachedData && !taskConfig.forceRefresh) {
                this.logger.info('Returning cached content data');
                return cachedData;
            }

            // Determine content type and appropriate scraping method
            const contentType = this.determineContentType(taskConfig.url);
            let result;

            switch (contentType) {
                case 'rss':
                    result = await this.handleRssFeed(taskConfig);
                    break;
                case 'social':
                    result = await this.handleSocialMedia(taskConfig);
                    break;
                case 'news':
                    result = await this.handleNewsArticle(taskConfig);
                    break;
                case 'blog':
                    result = await this.handleBlogPost(taskConfig);
                    break;
                default:
                    result = await this.handleGenericContent(taskConfig);
            }

            // Enrich and clean the content
            const enrichedContent = await this.enrichContent(result, taskConfig);

            // Cache the results
            await this.cacheSet(cacheKey, enrichedContent, this.getCacheTTL(contentType));

            return enrichedContent;
        } catch (error) {
            this.logger.error('Content aggregation failed:', error);
            return this.handleFailover(taskConfig, error);
        }
    }

    determineContentType(url) {
        if (url.includes('feed') || url.includes('rss') || url.includes('atom')) {
            return 'rss';
        }
        if (url.match(/twitter\.com|facebook\.com|linkedin\.com|instagram\.com/)) {
            return 'social';
        }
        if (url.match(/news|article|press/)) {
            return 'news';
        }
        if (url.match(/blog|post/)) {
            return 'blog';
        }
        return 'generic';
    }

    async handleRssFeed(taskConfig) {
        const response = await fetch(taskConfig.url);
        const feed = await response.text();
        const $ = cheerio.load(feed, { xmlMode: true });

        const items = [];
        $('item, entry').each((_, element) => {
            items.push({
                title: $(element).find('title').text(),
                link: $(element).find('link').text(),
                description: $(element).find('description, content').text(),
                pubDate: $(element).find('pubDate, published').text(),
                author: $(element).find('author, creator').text(),
                categories: $(element).find('category').map((_, el) => $(el).text()).get()
            });
        });

        return {
            type: 'rss',
            items,
            feedMetadata: {
                title: $('channel > title, feed > title').text(),
                description: $('channel > description, feed > subtitle').text(),
                lastUpdated: $('channel > lastBuildDate, feed > updated').text()
            }
        };
    }

    async handleSocialMedia(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle dynamic loading
            await this.handleInfiniteScroll(page, taskConfig);

            // Extract social media content
            return await page.evaluate((config) => {
                const posts = [];
                document.querySelectorAll(config.selectors.posts).forEach(post => {
                    posts.push({
                        text: post.querySelector(config.selectors.text)?.textContent,
                        author: post.querySelector(config.selectors.author)?.textContent,
                        timestamp: post.querySelector(config.selectors.timestamp)?.textContent,
                        engagement: {
                            likes: post.querySelector(config.selectors.likes)?.textContent,
                            shares: post.querySelector(config.selectors.shares)?.textContent,
                            comments: post.querySelector(config.selectors.comments)?.textContent
                        },
                        media: Array.from(post.querySelectorAll(config.selectors.media))
                            .map(media => ({
                                type: media.tagName.toLowerCase(),
                                url: media.src || media.href,
                                alt: media.alt || media.title
                            }))
                    });
                });
                return {
                    type: 'social',
                    platform: window.location.hostname.split('.')[1],
                    posts
                };
            }, taskConfig);
        });
    }

    async handleNewsArticle(taskConfig) {
        // Try Cheerio first for better performance
        try {
            return await this.scrapeNewsWithCheerio(taskConfig);
        } catch (error) {
            // Fallback to Playwright for dynamic content
            return await this.scrapeNewsWithPlaywright(taskConfig);
        }
    }

    async scrapeNewsWithCheerio(taskConfig) {
        const response = await fetch(taskConfig.url, {
            headers: {
                'User-Agent': await this.getRandomUserAgent()
            }
        });
        const html = await response.text();
        const $ = cheerio.load(html);

        return {
            type: 'news',
            title: $('h1').first().text(),
            content: this.extractArticleContent($),
            author: this.extractAuthor($),
            publishDate: this.extractPublishDate($),
            modifiedDate: this.extractModifiedDate($),
            metadata: this.extractArticleMetadata($)
        };
    }

    async scrapeNewsWithPlaywright(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Handle paywalls if necessary
            await this.handlePaywall(page);

            return await page.evaluate(() => {
                // Use schema.org metadata if available
                const schemaData = document.querySelector('script[type="application/ld+json"]');
                if (schemaData) {
                    try {
                        return JSON.parse(schemaData.textContent);
                    } catch (e) {
                        console.error('Failed to parse schema data');
                    }
                }

                // Fallback to manual extraction
                return {
                    type: 'news',
                    title: document.querySelector('h1')?.textContent,
                    content: this.extractMainContent(),
                    author: this.extractAuthorInfo(),
                    publishDate: this.extractPublishDate(),
                    metadata: this.extractMetadata()
                };
            });
        });
    }

    async handleBlogPost(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract blog content
            const content = await page.evaluate(() => {
                const article = document.querySelector('article') || document.querySelector('main');
                return {
                    type: 'blog',
                    title: document.querySelector('h1')?.textContent,
                    content: article?.innerHTML,
                    author: this.extractAuthorInfo(),
                    publishDate: document.querySelector('time')?.getAttribute('datetime'),
                    tags: Array.from(document.querySelectorAll('.tags a, .categories a'))
                        .map(tag => tag.textContent),
                    comments: this.extractComments()
                };
            });

            // Clean and sanitize content
            content.content = await sanitizeHtml(content.content);

            return content;
        });
    }

    async handleGenericContent(taskConfig) {
        return this.withPage(async (page) => {
            await page.goto(taskConfig.url, {
                waitUntil: 'networkidle',
                timeout: this.config.settings.timeout
            });

            // Extract main content
            const content = await page.evaluate(() => {
                return {
                    type: 'generic',
                    title: document.title,
                    content: document.body.innerHTML,
                    metadata: this.extractMetadata()
                };
            });

            // Clean and process content
            content.content = await this.processGenericContent(content.content);

            return content;
        });
    }

    async handleInfiniteScroll(page, taskConfig) {
        const maxScrolls = taskConfig.maxScrolls || 5;
        let lastHeight = await page.evaluate('document.body.scrollHeight');

        for (let i = 0; i < maxScrolls; i++) {
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await page.waitForTimeout(2000); // Wait for content to load

            const newHeight = await page.evaluate('document.body.scrollHeight');
            if (newHeight === lastHeight) {
                break;
            }
            lastHeight = newHeight;
        }
    }

    async handlePaywall(page) {
        const paywallSelectors = [
            '.paywall',
            '.subscription-required',
            '.premium-content'
        ];

        for (const selector of paywallSelectors) {
            try {
                await page.evaluate((sel) => {
                    const element = document.querySelector(sel);
                    if (element) element.remove();
                }, selector);
            } catch (error) {
                continue;
            }
        }
    }

    async enrichContent(content, taskConfig) {
        try {
            // Use Gemini API for content analysis
            const apiKey = await this.getApiKey('gemini');
            const enrichedData = await this.analyzeContentWithGemini(content, apiKey);

            // Add additional metadata
            const metadata = await this.extractMetadata(content);

            return {
                ...content,
                analysis: enrichedData,
                metadata
            };
        } catch (error) {
            this.logger.error('Content enrichment failed:', error);
            return content;
        }
    }

    async analyzeContentWithGemini(content, apiKey) {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const prompt = `
            Analyze this content and provide insights on:
            1. Main topics and themes
            2. Key takeaways
            3. Sentiment analysis
            4. Content quality assessment
            5. Target audience
            6. Credibility indicators
            7. Related topics
            8. Content categorization

            Content:
            ${JSON.stringify(content, null, 2)}
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
            type: this.determineContentType(taskConfig.url),
            timestamp: Math.floor(Date.now() / (1000 * 60 * 15)) // 15-minute buckets
        };
        return JSON.stringify(key);
    }

    getCacheTTL(contentType) {
        // Different TTLs based on content type
        const ttls = {
            rss: 900,      // 15 minutes
            social: 300,    // 5 minutes
            news: 1800,     // 30 minutes
            blog: 3600,     // 1 hour
            generic: 7200   // 2 hours
        };
        return ttls[contentType] || ttls.generic;
    }

    async handleFailover(taskConfig, error) {
        // Try alternative methods
        const methods = [
            this.tryApifyActor,
            this.trySerpApi,
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

        throw new Error('Failed to aggregate content from all sources');
    }
}

module.exports = { ContentAggregationHandler };
