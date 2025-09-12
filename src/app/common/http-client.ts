import fs from 'fs/promises';
import fetch from 'node-fetch';
import { getQuickJS } from '@tootallnate/quickjs-emscripten';
import { createPacResolver } from 'pac-resolver';
import axios, { AxiosHeaders, AxiosInstance, HeadersDefaults, RawAxiosRequestHeaders } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Agent } from 'http';

import puppeteer, { Browser } from 'puppeteer';
import { PuppeteerExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const { PROXY_TYPE = '', PROXY_FIXED_URL = '', PROXY_PAC_URL = '' } = process.env as { PROXY_TYPE: string, PROXY_FIXED_URL: string, PROXY_PAC_URL: string };

const proxyMap = new Map<string, string>();
const noProxyAgent = new Agent({ keepAlive: true });
const proxyPacMap: { [PROXY_PAC_URL: string]: string } = {};

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
            pacScript = await fs.readFile(PROXY_PAC_URL, 'utf-8');
            // throw new Error('PROXY_PAC_URL is not valid');
        }
        proxyPacMap[PROXY_PAC_URL] = pacScript;

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


// puppeteer-extraをインスタンス化
const puppeteerExtra = new PuppeteerExtra(puppeteer);
// StealthPluginを登録
puppeteerExtra.use(StealthPlugin());

export async function getPuppeteer(): Promise<Browser> {
    const browserArgs = ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'];
    if (PROXY_TYPE === 'FIXED') {
        browserArgs.push(`--proxy-server=${PROXY_FIXED_URL}`);
    } else if (PROXY_TYPE === 'PAC') {
        browserArgs.push(`--proxy-pac-url=${PROXY_PAC_URL}`);
        // let proxyUrl = '';
        // try {
        //     proxyUrl = await getProxyUrl(url);
        //     if (proxyUrl) {
        //         browserArgs.push(`--proxy-server=${proxyUrl}`);
        //     } else {
        //         browserArgs.push(`--no-proxy-server`);
        //     }
        // } catch (err) {
        //     browserArgs.push('--no-proxy-server');
        //     console.error('getProxyUrlError');
        //     console.error(err);
        // }
    } else {
        browserArgs.push(`--no-proxy-server`);
    }

    // ブラウザの起動オプションを設定
    const browser = await puppeteerExtra.launch({
        headless: true,
        // ignoreHTTPSErrors: true,  // SSL証明書エラーを無視
        args: browserArgs,
    }); // ヘッドレスブラウザを起動
    return browser;
}
