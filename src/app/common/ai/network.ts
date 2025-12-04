import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';

const proxyObj: { [key: string]: string | undefined } = {
    httpProxy: process.env['http_proxy'] || undefined,
    httpsProxy: process.env['https_proxy'] || undefined,
};

const noProxies = (process.env['no_proxy']?.split(',') || []).filter(Boolean);

function extractDomain(urlString: string | null | undefined): string | null {
    if (!urlString) return null;
    try {
        const url = new URL(urlString);
        return url.hostname;
    } catch {
        return null;
    }
}

export function getHttpsProxyAgent(urlString: string): HttpsProxyAgent<any> | undefined {
    const domain = extractDomain(urlString) as string;
    Object.keys(proxyObj).filter(key => noProxies.includes(domain) || !proxyObj[key]).forEach(key => delete proxyObj[key]);
    const options = Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0
        ? { httpAgent: new HttpsProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '') }
        : {};
    return options.httpAgent;
}

export function getUndiciHttpProxy(urlString: string): ProxyAgent | undefined {
    const domain = extractDomain(urlString) as string;
    Object.keys(proxyObj).filter(key => noProxies.includes(domain) || !proxyObj[key]).forEach(key => delete proxyObj[key]);
    const options = Object.keys(proxyObj).filter(key => proxyObj[key]).length > 0
        ? { httpAgent: new ProxyAgent(proxyObj.httpsProxy || proxyObj.httpProxy || '') }
        : {};
    return options.httpAgent;
}
