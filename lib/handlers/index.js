const { BaseHandler } = require('./baseHandler');
const { JobMarketHandler } = require('./jobMarketHandler');
const { EcommerceHandler } = require('./ecommerceHandler');
const { RealEstateHandler } = require('./realEstateHandler');
const { ContentAggregationHandler } = require('./contentAggregationHandler');
const { ResearchHandler } = require('./researchHandler');
const { FinancialHandler } = require('./financialHandler');
const { TravelHandler } = require('./travelHandler');
const { LeadGenerationHandler } = require('./leadGenerationHandler');
const { RegulatoryHandler } = require('./regulatoryHandler');
const { MarketResearchHandler } = require('./marketResearchHandler');

// Factory function to create appropriate handler based on category
const createHandler = (category, options) => {
    const handlers = {
        'job_market': JobMarketHandler,
        'ecommerce': EcommerceHandler,
        'real_estate': RealEstateHandler,
        'content': ContentAggregationHandler,
        'research': ResearchHandler,
        'financial': FinancialHandler,
        'travel': TravelHandler,
        'lead_generation': LeadGenerationHandler,
        'regulatory': RegulatoryHandler,
        'market_research': MarketResearchHandler
    };

    const HandlerClass = handlers[category];
    if (!HandlerClass) {
        throw new Error(`No handler found for category: ${category}`);
    }

    return new HandlerClass(options);
};

module.exports = {
    // Export factory function
    createHandler,

    // Export individual handlers for direct use
    BaseHandler,
    JobMarketHandler,
    EcommerceHandler,
    RealEstateHandler,
    ContentAggregationHandler,
    ResearchHandler,
    FinancialHandler,
    TravelHandler,
    LeadGenerationHandler,
    RegulatoryHandler,
    MarketResearchHandler,

    // Handler categories for reference
    HANDLER_CATEGORIES: [
        'job_market',
        'ecommerce',
        'real_estate',
        'content',
        'research',
        'financial',
        'travel',
        'lead_generation',
        'regulatory',
        'market_research'
    ]
};
