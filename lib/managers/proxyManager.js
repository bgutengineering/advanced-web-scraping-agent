const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { Logger } = require('../utils/logger');

class ProxyManager extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.logger = new Logger();
        this.proxies = new Map(); // provider type -> proxy list
        this.healthStatus = new Map(); // proxy -> health status
        this.lastUsed = new Map(); // proxy -> last used timestamp
        this.providerAssignments = new Map(); // scraping provider -> proxy list
        
        this.initialize();
        if (this.config.enabled) {
            this.startHealthChecks();
        }
    }

    initialize() {
        if (!this.config.enabled) {
            this.logger.info('Proxy management is disabled');
            return;
        }

        // Initialize proxies for each type
        for (const provider of this.config.providers) {
            this.proxies.set(provider.type, [...provider.list]);
            
            // Initialize health status for each proxy
            for (const proxy of provider.list) {
                this.healthStatus.set(proxy, {
                    healthy: true,
                    lastCheck: null,
                    failCount: 0,
                    responseTime: 0
                });
            }
        }

        this.logger.info(`Initialized ${this.getTotalProxyCount()} proxies`);
    }

    async getProxy(scrapingProvider, previousProxy = null) {
        if (!this.config.enabled) return null;

        // Get assigned proxies for the scraping provider
        let assignedProxies = this.providerAssignments.get(scrapingProvider);
        if (!assignedProxies) {
            // If no assignment exists, create one based on proxy types needed
            assignedProxies = this.assignProxiesToProvider(scrapingProvider);
        }

        // Filter healthy proxies
        const healthyProxies = assignedProxies.filter(proxy => 
            this.healthStatus.get(proxy)?.healthy
        );

        if (healthyProxies.length === 0) {
            this.logger.warn(`No healthy proxies available for ${scrapingProvider}`);
            // Reset assignments and try again with all proxies
            this.providerAssignments.delete(scrapingProvider);
            return this.getProxy(scrapingProvider);
        }

        // Select proxy based on least recently used
        const sortedProxies = healthyProxies.sort((a, b) => 
            (this.lastUsed.get(a) || 0) - (this.lastUsed.get(b) || 0)
        );

        // Avoid using the same proxy as before if possible
        const selectedProxy = previousProxy && sortedProxies.length > 1
            ? sortedProxies.find(p => p !== previousProxy) || sortedProxies[0]
            : sortedProxies[0];

        this.lastUsed.set(selectedProxy, Date.now());
        return selectedProxy;
    }

    assignProxiesToProvider(scrapingProvider) {
        // Logic to assign appropriate proxies based on provider needs
        // This could be enhanced based on specific provider requirements
        const allProxies = Array.from(this.proxies.values()).flat();
        this.providerAssignments.set(scrapingProvider, allProxies);
        return allProxies;
    }

    createProxyAgent(proxyUrl) {
        if (proxyUrl.startsWith('socks')) {
            return new SocksProxyAgent(proxyUrl);
        } else {
            return new HttpsProxyAgent(proxyUrl);
        }
    }

    async checkProxyHealth(proxy) {
        const startTime = Date.now();
        const agent = this.createProxyAgent(proxy);

        try {
            await new Promise((resolve, reject) => {
                const request = https.get({
                    hostname: 'www.google.com',
                    port: 443,
                    path: '/',
                    agent,
                    timeout: 10000
                }, (response) => {
                    if (response.statusCode === 200) {
                        resolve();
                    } else {
                        reject(new Error(`HTTP ${response.statusCode}`));
                    }
                });

                request.on('error', reject);
                request.on('timeout', () => {
                    request.destroy();
                    reject(new Error('Timeout'));
                });
            });

            const responseTime = Date.now() - startTime;
            this.updateProxyHealth(proxy, true, responseTime);
            return true;
        } catch (error) {
            this.updateProxyHealth(proxy, false);
            return false;
        }
    }

    updateProxyHealth(proxy, healthy, responseTime = null) {
        const status = this.healthStatus.get(proxy) || {
            healthy: true,
            lastCheck: null,
            failCount: 0,
            responseTime: 0
        };

        if (healthy) {
            status.healthy = true;
            status.failCount = 0;
            if (responseTime) status.responseTime = responseTime;
        } else {
            status.failCount++;
            status.healthy = status.failCount < 3; // Mark unhealthy after 3 failures
        }

        status.lastCheck = Date.now();
        this.healthStatus.set(proxy, status);

        // Emit events for monitoring
        this.emit('proxyHealthUpdate', { proxy, status });
    }

    startHealthChecks() {
        const interval = this.config.healthCheck?.interval || 300000; // Default 5 minutes
        
        setInterval(async () => {
            const proxies = Array.from(this.healthStatus.keys());
            for (const proxy of proxies) {
                await this.checkProxyHealth(proxy);
            }
        }, interval);
    }

    markProxyError(proxy, error) {
        const status = this.healthStatus.get(proxy);
        if (status) {
            status.failCount++;
            status.lastError = error;
            status.healthy = status.failCount < 3;
            this.healthStatus.set(proxy, status);
        }
        this.emit('proxyError', { proxy, error });
    }

    getTotalProxyCount() {
        return Array.from(this.proxies.values())
            .reduce((total, list) => total + list.length, 0);
    }

    getHealthyProxyCount() {
        return Array.from(this.healthStatus.entries())
            .filter(([_, status]) => status.healthy)
            .length;
    }

    getProxyStats() {
        return {
            total: this.getTotalProxyCount(),
            healthy: this.getHealthyProxyCount(),
            providers: Object.fromEntries(
                Array.from(this.proxies.entries()).map(([type, list]) => [
                    type,
                    {
                        total: list.length,
                        healthy: list.filter(proxy => 
                            this.healthStatus.get(proxy)?.healthy
                        ).length
                    }
                ])
            )
        };
    }

    async close() {
        // Cleanup any ongoing health check intervals
        clearInterval(this._healthCheckInterval);
        this.logger.info('Proxy manager shutdown complete');
    }
}

module.exports = { ProxyManager };
