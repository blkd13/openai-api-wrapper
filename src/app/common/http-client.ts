import fs from 'fs/promises';
import fetch from 'node-fetch';
import { getQuickJS } from '@tootallnate/quickjs-emscripten';
import { createPacResolver } from 'pac-resolver';
import axios, { AxiosHeaders, AxiosInstance, HeadersDefaults, RawAxiosRequestHeaders } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent } from 'http';

const { PROXY_TYPE = '', PROXY_FIXED_URL = '', PROXY_PAC_URL = '' } = process.env as { PROXY_TYPE: string, PROXY_FIXED_URL: string, PROXY_PAC_URL: string };

const proxyMap = new Map<string, string>();
const noProxyAgent = new Agent({ keepAlive: true });
const proxyPacMap: { [key: string]: string } = {};

export async function getProxyUrl(targetUrl: string): Promise<string> {
    const urlObject = new URL(targetUrl);
    if (PROXY_TYPE === 'PAC') {
        if (proxyMap.has(urlObject.origin)) {
            return Promise.resolve(proxyMap.get(urlObject.origin) || '');
        } else { }

        let pacScript = '';
        if (proxyPacMap[PROXY_PAC_URL]) {
            pacScript = proxyPacMap[PROXY_PAC_URL];
        } else if (PROXY_PAC_URL.startsWith('http') || PROXY_PAC_URL.startsWith('https')) {
            // Fetch the PAC script from the URL
            const res = await fetch(PROXY_PAC_URL, { agent: noProxyAgent });
            if (!res.ok) {
                throw new Error(`Failed to fetch PAC script: ${res.status} ${res.statusText}`);
            }
            pacScript = await res.text();
        } else if (PROXY_PAC_URL.startsWith('file:')) {
            const path = new URL(PROXY_PAC_URL).pathname;
            pacScript = await fs.readFile(path, 'utf-8');
        } else {
            throw new Error('PROXY_PAC_URL is not valid');
        }
        proxyPacMap[pacScript] = pacScript;

        const quickjs = await getQuickJS();
        const FindProxyForURL = createPacResolver(quickjs, pacScript);

        const proxyResult = await FindProxyForURL(urlObject.origin);
        console.log('PAC result:', proxyResult);
        let proxyUrl = '';
        if (proxyResult.startsWith('PROXY')) {
            const [_, host, port] = proxyResult.match(/PROXY\s+(.+):(\d+)/) || [];
            proxyUrl = `http://${host}:${port}`;
        } else if (proxyResult.startsWith('DIRECT')) {
            proxyUrl = '';
        } else {
            throw new Error('Unexpected proxy result: ' + proxyResult);
        }
        proxyMap.set(urlObject.origin, proxyUrl);
        return proxyUrl;
    } else if (PROXY_TYPE === 'FIXED') {
        return Promise.resolve(PROXY_FIXED_URL || '');
    } else {
        return Promise.resolve('');
    }
}

export async function getAxios(targetUrl: string, headers?: RawAxiosRequestHeaders | AxiosHeaders | Partial<HeadersDefaults>): Promise<AxiosInstance> {
    const proxyUrl = await getProxyUrl(targetUrl);
    if (proxyUrl) {
        const agent = new HttpsProxyAgent(proxyUrl);
        return axios.create({ headers, httpAgent: agent, httpsAgent: agent, proxy: false, });
    } else {
        return axios.create({ headers, httpAgent: false, httpsAgent: false, proxy: false, });
    }
}
