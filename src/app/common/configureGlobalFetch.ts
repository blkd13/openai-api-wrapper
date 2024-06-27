// FROM https://gist.github.com/zicklag/1bb50db6c5138de347c224fda14286da

/**
 * Importing this modules will configure the global undici agent, which is used to provide
 * global `fetch()` support, to use an http proxy if present during development. Unfortunately
 * undici doesn't come with this functionality so we implement a solution that is not fully
 * correct as to the way that proxy environment variables are supposed to be parsed.
 * 
 * This only goes into effect during development, though, and it's functional enough for that
 * purpose.
 */

import { Agent, ProxyAgent, Dispatcher, setGlobalDispatcher } from 'undici';

// If we are in development mode and there is an `http_proxy` set
if (process.env.http_proxy) {
    // Collect the list of domains that we should not use a proxy for
    const noProxyList = (process.env.no_proxy && process.env.no_proxy.split(',')) || [];
    // Parse the proxy URL
    const proxyUrl = new URL(process.env.http_proxy);
    // Create an access token if the proxy requires authentication
    const token = proxyUrl.username && proxyUrl.password ?
        `Basic ${Buffer.from(`${proxyUrl.username}:${proxyUrl.password}`).toString('base64')}` : undefined;

    // Create a default agent that will be used for no_proxy origins
    const defaultAgent = new Agent();

    // Create an interceptor that will use the appropriate agent based on the origin and the no_proxy
    // environment variable.
    const noProxyInterceptor = (dispatch: Dispatcher['dispatch']): Dispatcher['dispatch'] => {
        return (opts, handler) => {
            let noProxy = false;
            for (const exclusion of noProxyList) {
                if (opts.origin?.toString().search(exclusion) != -1) {
                    noProxy = true;
                    break;
                }
            }
            return noProxy ?
                defaultAgent.dispatch(opts, handler) :
                dispatch(opts, handler);
        }
    };

    // Create a proxy agent that will send all requests through the configured proxy, unless the
    // noProxyInterceptor bypasses it.
    const proxyAgent = new ProxyAgent({
        uri: proxyUrl.protocol + proxyUrl.host,
        token,
        interceptors: {
            Client: [noProxyInterceptor]
        }
    });

    // Make sure our configured proxy agent is used for all `fetch()` requests globally.
    setGlobalDispatcher(proxyAgent);
}


const configureGlobalFetch = {}; // ファイルを読み込ませたいだけだからexportするオブジェクトは何でもよい。
export default configureGlobalFetch;